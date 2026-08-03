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
import { hasRole } from "@/domain/organization/membership";
import { currentTenant, DEFAULT_TENANT } from "@/shared/tenantContext";
import { log } from "@/shared/logger";
import { isConfiguredAdmin } from "./runtime-settings";

export interface Workspace {
  tenant: string;
  /** Absent in the default tenant, where `ADMIN_EMAILS` still answers for roles. */
  role?: OrganizationRole;
}

const DEFAULT_WORKSPACE: Workspace = { tenant: DEFAULT_TENANT };

/**
 * The workspace this caller acts in.
 *
 * A person in exactly one tenant acts in it. A person in several acts in the
 * first by id, deterministically — picking a workspace is a UI decision this
 * app does not offer yet, and an arbitrary choice that changed between requests
 * would be worse than a fixed one.
 *
 * A lookup failure resolves to the default tenant rather than throwing: the
 * alternative is that a membership-store blip logs every user out of their own
 * data. It is safe in the direction that matters — the default tenant's rows
 * are not any named tenant's rows, so a failure denies rather than grants.
 */
export async function resolveWorkspace(userEmail: string): Promise<Workspace> {
  try {
    const memberships = await membershipRepository.listByUser(userEmail);
    if (memberships.length === 0) {
      return DEFAULT_WORKSPACE;
    }
    const chosen = [...memberships].sort((a, b) =>
      a.organizationId.localeCompare(b.organizationId),
    )[0]!;
    return { tenant: chosen.organizationId, role: chosen.role };
  } catch (error) {
    log.error("authz", `could not resolve the workspace of ${userEmail}`, error);
    return DEFAULT_WORKSPACE;
  }
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
 */
export function machineTenant(request: Request): string {
  const header = request.headers.get("x-tenant")?.trim();
  if (header) {
    return header;
  }
  const query = new URL(request.url).searchParams.get("tenant")?.trim();
  return query || DEFAULT_TENANT;
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
  try {
    const membership = await membershipRepository.get(tenant, userEmail);
    return membership ? hasRole(membership.role, "admin") : false;
  } catch (error) {
    log.error("authz", `could not read the membership of ${userEmail} in ${tenant}`, error);
    return false;
  }
}
