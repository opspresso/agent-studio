import { unauthorized } from "@/shared/unauthorized";
import { headers } from "next/headers";
import { hasRole, type OrganizationRole } from "@/domain/organization/membership";
import { DEFAULT_TENANT, withTenant } from "@/shared/tenantContext";
import { auth } from "./auth";
import { isAdminEmail, isConfiguredAdmin } from "./runtime-settings";
import { hasWorkspaces, resolveWorkspace, WorkspaceUnavailableError } from "./workspace";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
  /** The workspace this request acts in; see `lib/workspace.ts`. */
  tenant: string;
  /** The caller's role in it. Absent in the default tenant. */
  role?: OrganizationRole;
}

/**
 * Whether this request carries a valid session, without asking which workspace
 * it belongs to.
 *
 * For the two pages that only need the question answered — the marketing home
 * and `/login`, which either render or redirect. Neither reads `tenant` or
 * `role`, and resolving one would put a membership lookup on the path of every
 * signed-out visitor and make a sign-in page that cannot render when the
 * membership store is unavailable.
 */
export async function hasSession(): Promise<boolean> {
  return (await auth.api.getSession({ headers: await headers() })) !== null;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return null;
  }
  const { user } = session;
  const workspace = await resolveWorkspace(user.email);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image ?? null,
    tenant: workspace.tenant,
    ...(workspace.role ? { role: workspace.role } : {}),
  };
}

/**
 * Wrap a route handler with session enforcement.
 * Usage: `export const GET = withAuth(async (user, request, ctx) => Response.json(...))`
 *
 * The handler runs **inside the caller's tenant scope**, which is what makes
 * cross-tenant isolation structural rather than a check each route has to
 * remember: every key builder takes the tenant, so a query issued in here
 * cannot address another tenant's rows at all.
 */
export function withAuth<T extends unknown[]>(
  handler: (user: SessionUser, ...args: T) => Promise<Response>,
): (...args: T) => Promise<Response> {
  return async (...args: T) => {
    let user;
    try {
      user = await getSessionUser();
    } catch (error) {
      // Only this one, and only here: `resolveWorkspace` refuses rather than
      // guessing a tenant, and the refusal has to become a status instead of an
      // unhandled throw Next renders as 500.
      if (!(error instanceof WorkspaceUnavailableError)) {
        throw error;
      }
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (!user) {
      return unauthorized();
    }
    return withTenant(user.tenant, () => handler(user, ...args));
  };
}

/**
 * True when this caller may mutate the tenant's shared resources.
 *
 * Inside a workspace the answer is the membership role, and the `ADMIN_EMAILS`
 * fail-open — "an empty list means everyone" — does not apply: a tenant's
 * members are named, so "nobody was named" cannot mean "everybody". Outside one
 * (the default tenant, which is every deployment that has not opted in) the
 * rule is exactly what it has always been.
 */
export function isAdmin(user: SessionUser): Promise<boolean> {
  return user.role ? Promise.resolve(hasRole(user.role, "admin")) : isAdminEmail(user.email);
}

/** True when this caller may create projects — a `viewer` may run, not author. */
export function canAuthor(user: SessionUser): Promise<boolean> {
  return user.role ? Promise.resolve(hasRole(user.role, "editor")) : Promise.resolve(true);
}

const FORBIDDEN = (message: string) => Response.json({ error: message }, { status: 403 });

/**
 * Like {@link withAuth}, but additionally 403s non-admins. Used for mutations
 * on shared registries (MCP servers, external agents, skills).
 */
export function withAdminAuth<T extends unknown[]>(
  handler: (user: SessionUser, ...args: T) => Promise<Response>,
): (...args: T) => Promise<Response> {
  return withAuth(async (user, ...args: T) => {
    if (!(await isAdmin(user))) {
      return FORBIDDEN("Only admins can modify this resource");
    }
    return handler(user, ...args);
  });
}

/**
 * True when this caller administers the *deployment* — as distinct from
 * administering a workspace inside it.
 *
 * The two were one question until workspaces existed, and merging them is the
 * hole this closes: `isAdmin` now answers "yes" for anyone holding the `admin`
 * role in their own workspace, and a handful of admin-gated surfaces are not
 * their workspace's at all. The app settings row, the inbound A2A key and the
 * managed MCP containers are one per deployment and shared by every tenant, so
 * a workspace admin reaching them could read the deployment's LLM credentials,
 * rotate a key every other tenant depends on, or provision containers on shared
 * infrastructure.
 *
 * `ADMIN_EMAILS` answers, whatever workspace the caller happens to be in — the
 * list *is* the deployment's operators, and joining a workspace is not a reason
 * to stop being one. The pre-tenant "an empty list means no restriction" rule
 * still applies, but only where it always did: a deployment with no workspaces
 * at all. Otherwise an unset list would make every member of every workspace a
 * deployment administrator, which is the merge again with extra steps.
 */
export async function isDeploymentAdmin(user: SessionUser): Promise<boolean> {
  if (await isConfiguredAdmin(user.email)) {
    return true;
  }
  // Both halves, because each covers what the other cannot. The caller must be
  // in no workspace — a member is governed by their role, not by a list that
  // names nobody — *and* the deployment must have none, which is the question
  // the caller's own resolution cannot answer: on a deployment that has
  // workspaces and an empty admin list, everyone without a membership resolves
  // to the default tenant, and every one of them would be an operator.
  if (user.tenant !== DEFAULT_TENANT || (await hasWorkspaces())) {
    return false;
  }
  return isAdminEmail(user.email);
}

/**
 * Like {@link withAdminAuth}, but for the resources one deployment shares
 * across every workspace rather than the ones a workspace owns. See
 * {@link isDeploymentAdmin} for which those are and why they are separate.
 */
export function withDeploymentAdminAuth<T extends unknown[]>(
  handler: (user: SessionUser, ...args: T) => Promise<Response>,
): (...args: T) => Promise<Response> {
  return withAuth(async (user, ...args: T) => {
    if (!(await isDeploymentAdmin(user))) {
      return FORBIDDEN("Only a deployment administrator can access this resource");
    }
    return handler(user, ...args);
  });
}

/**
 * Like {@link withAuth}, but 403s a caller who may only read and run. The
 * shared-catalog semantics are kept *inside* a workspace — what the tenant
 * boundary reverses is who is in the room, not how open the room is — so this
 * gates authoring, not reading.
 */
export function withAuthorAuth<T extends unknown[]>(
  handler: (user: SessionUser, ...args: T) => Promise<Response>,
): (...args: T) => Promise<Response> {
  return withAuth(async (user, ...args: T) => {
    if (!(await canAuthor(user))) {
      return FORBIDDEN("Your role in this workspace does not allow creating projects");
    }
    return handler(user, ...args);
  });
}
