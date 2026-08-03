/**
 * Which workspace a caller is acting in, and what they may do there.
 *
 * This is the whole of the tenant read boundary. Because every key builder is
 * tenant-scoped and `withAuth` enters the caller's scope before the handler
 * runs, a route cannot read another tenant's rows by forgetting a check — the
 * query simply does not address them. What is left for this module is the two
 * questions a key cannot answer: which tenant is this caller in, and what is
 * their role in it.
 *
 * **A caller with no membership is the default tenant.** That is the
 * compatibility contract: every existing deployment has no organization rows,
 * so every user resolves to the unprefixed scope and the admin rules below fall
 * back to `ADMIN_EMAILS` exactly as they always have. Multi-tenancy is
 * something a deployment opts into by creating an organization and a
 * membership, not something that changes underneath it.
 */

import type { OrganizationRole } from "@/domain/organization/membership";
import { membershipRepository } from "@/infrastructure/db/repositories/membershipRepository";
import { organizationRepository } from "@/infrastructure/db/repositories/organizationRepository";
import { hasRole } from "@/domain/organization/membership";
import { AppError } from "@/application/errors";
import { currentTenant, DEFAULT_TENANT } from "@/shared/tenantContext";
import { createTtlCache } from "@/shared/ttlCache";
import { normalizeEmail } from "@/shared/email";
import { isSlug } from "@/shared/slug";
import { log } from "@/shared/logger";
import { positiveIntEnv } from "./config";
import { isConfiguredAdmin } from "./runtime-settings";

export interface Workspace {
  tenant: string;
  /** Absent in the default tenant, where `ADMIN_EMAILS` still answers for roles. */
  role?: OrganizationRole;
}

const DEFAULT_WORKSPACE: Workspace = { tenant: DEFAULT_TENANT };

/**
 * The membership store could not be read, so which workspace this caller is in
 * is unknown — and an unknown workspace is not a workspace we may guess at.
 *
 * 503 rather than 500 because it is a dependency being unavailable rather than
 * this app being wrong, and because it is the honest answer: retrying later is
 * exactly what a caller should do.
 */
export class WorkspaceUnavailableError extends AppError {
  constructor() {
    super("Could not determine your workspace; try again shortly", 503);
  }
}

/**
 * The workspace resolution is read on every authenticated request, and its
 * answer changes only when someone edits a membership — so it is cached under
 * the same short TTL and the same process-local honesty as the settings cache
 * (`runtime-settings.ts`): a change lands on other instances when their entries
 * expire. Bounded by entry count as well as by time, because the key is an
 * email and a map keyed by anything a caller supplies grows without one.
 */
const WORKSPACE_TTL_MS = positiveIntEnv("WORKSPACE_CACHE_TTL_MS", 5_000, 1);
const workspaceCache = createTtlCache<Workspace>({ ttlMs: WORKSPACE_TTL_MS, maxEntries: 2_048 });

/**
 * Whether this deployment has any workspaces at all — the question the
 * pre-tenant `ADMIN_EMAILS` fail-open is allowed to depend on. Cached under the
 * same TTL: it changes only when an organization is registered or removed, and
 * both invalidate.
 */
const workspacesExistCache = createTtlCache<boolean>({ ttlMs: WORKSPACE_TTL_MS, maxEntries: 1 });

/** Drop the cached resolutions. Called when a membership or organization changes. */
export function invalidateWorkspaceCache(): void {
  workspaceCache.clear();
  workspacesExistCache.clear();
}

/**
 * True when at least one workspace is registered.
 *
 * **Fails closed**: a registry that cannot be read is treated as "there are
 * workspaces", because the only thing this answer widens is the fail-open, and
 * widening it on a failed read is how an unset `ADMIN_EMAILS` would hand
 * deployment administration to whoever asked during the outage.
 */
export async function hasWorkspaces(): Promise<boolean> {
  const cached = workspacesExistCache.get("any");
  if (cached !== undefined) {
    return cached;
  }
  let exists: boolean;
  try {
    exists = (await organizationRepository.list()).length > 0;
  } catch (error) {
    log.error("authz", "could not read the workspace registry", error);
    exists = true;
  }
  // The fail-closed answer is cached too. This question is asked on every
  // request that reaches a deployment-admin gate, so leaving the failure
  // uncached turns an index that is already throttling into one queried once
  // per request, each attempt failing and logging. The value is only unsafe to
  // *widen*; reusing it for the same few seconds narrows, and the TTL is what
  // lets the real answer come back.
  workspacesExistCache.set("any", exists);
  return exists;
}

/**
 * The workspace this caller acts in.
 *
 * A person in exactly one tenant acts in it. A person in several acts in the
 * first by id, deterministically — picking a workspace is a UI decision this
 * app does not offer yet, and an arbitrary choice that changed between requests
 * would be worse than a fixed one.
 *
 * A lookup failure **refuses the request** rather than falling back to the
 * default tenant. The fallback reads as safe — the default tenant's rows are
 * not any named tenant's rows — but it is safe in the wrong direction on the
 * deployment that matters: one that migrated *some* users into workspaces and
 * left the original catalog in the default scope. There a blip drops a
 * workspace member into the shared catalog with no role, which `canAuthor` and
 * `isAdmin` then answer for with the pre-tenant `ADMIN_EMAILS` rules. And the
 * availability argument for falling back is thin: the read that failed is a
 * read of the same table every later read in the request uses.
 *
 * The address is normalized first, because a membership is *keyed* by it: an
 * identity provider that returns `Bruce@Corp.com` would otherwise miss the row
 * written for `bruce@corp.com` and take the no-membership arm — which is the
 * fallback above, arrived at silently instead of by a failure.
 */
export async function resolveWorkspace(rawEmail: string): Promise<Workspace> {
  const userEmail = normalizeEmail(rawEmail);
  const cached = workspaceCache.get(userEmail);
  if (cached) {
    return cached;
  }
  let memberships;
  try {
    memberships = await membershipRepository.listByUser(userEmail);
  } catch (error) {
    log.error("authz", `could not resolve the workspace of ${userEmail}`, error);
    throw new WorkspaceUnavailableError();
  }
  const chosen = [...memberships].sort((a, b) =>
    a.organizationId.localeCompare(b.organizationId),
  )[0];
  const resolved: Workspace = chosen
    ? { tenant: chosen.organizationId, role: chosen.role }
    : DEFAULT_WORKSPACE;
  workspaceCache.set(userEmail, resolved);
  return resolved;
}

/**
 * The workspace a machine caller acts in: `X-Tenant`, or a `tenant` query
 * parameter for callers that cannot set headers — Slack posts to whatever
 * Request URL it was configured with and adds nothing to it.
 *
 * A hint rather than a path change, so every credential issued before tenants
 * existed keeps working: omitted means the default tenant, which is where those
 * credentials live. And a hint rather than a grant — the credential is verified
 * *inside* the named tenant, so pointing at someone else's finds no matching
 * secret and authenticates nobody.
 *
 * Returns `null` for a value that is not a slug, which the caller answers with
 * a 400. An organization id is a slug and is also a key prefix, so anything
 * else names a scope no tenant owns: without this the request would run under
 * `T#Acme #`, find nothing, and get a bare 401 that says the credential was
 * wrong when what was wrong was the tenant name.
 */
export function machineTenant(request: Request): string | null {
  const header = request.headers.get("x-tenant")?.trim();
  const named = header || new URL(request.url).searchParams.get("tenant")?.trim();
  if (!named) {
    return DEFAULT_TENANT;
  }
  return named === DEFAULT_TENANT || isSlug(named) ? named : null;
}

/**
 * The project write override, answered in whatever workspace the caller is
 * acting in. Wired into `assertProjectWritable` by the composition root, which
 * is why it takes only an email: the tenant rides the async context, so the
 * twenty-odd call sites of that gate stay untouched and none of them can get
 * the question wrong.
 *
 * Fails closed on a lookup failure. `assertProjectWritable` returns a
 * deterministic 403 to a non-owner and must keep doing so — a membership-store
 * blip turning that into a 500 would change which error an unauthorized caller
 * sees.
 */
export async function isWorkspaceAdmin(userEmail: string): Promise<boolean> {
  const tenant = currentTenant();
  if (tenant === DEFAULT_TENANT) {
    return isConfiguredAdmin(userEmail);
  }
  return isAdminOfOrganization(userEmail, tenant);
}

/**
 * True when this person holds `admin` in the *named* workspace, whichever one
 * they happen to be acting in.
 *
 * `resolveWorkspace` picks one workspace for a person who is in several, so the
 * ambient answer cannot speak for the others. Managing members is the one place
 * that has to: the workspace being administered is named in the URL.
 *
 * Fails closed, like {@link isWorkspaceAdmin} and for the same reason — a
 * lookup failure must not turn a deterministic 403 into anything else.
 */
export async function isAdminOfOrganization(
  rawEmail: string,
  organizationId: string,
): Promise<boolean> {
  const userEmail = normalizeEmail(rawEmail);
  try {
    const membership = await membershipRepository.get(organizationId, userEmail);
    return membership ? hasRole(membership.role, "admin") : false;
  } catch (error) {
    log.error(
      "authz",
      `could not read the membership of ${userEmail} in ${organizationId}`,
      error,
    );
    return false;
  }
}
