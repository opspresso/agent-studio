import { unauthorized } from "@/shared/unauthorized";
import { headers } from "next/headers";
import { hasRole, type OrganizationRole } from "@/domain/organization/membership";
import { withTenant } from "@/shared/tenantContext";
import { auth } from "./auth";
import { isAdminEmail } from "./runtime-settings";
import { resolveWorkspace } from "./workspace";

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
    const user = await getSessionUser();
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
