/**
 * What a person may do inside one tenant.
 *
 * Three roles, each named for a capability that exists today rather than for
 * one a pricing page might want later: a role nobody can act on is a permission
 * check that always passes, which is worse than no role at all.
 *
 * - `viewer` — read and run every project in the tenant. This is the shared
 *   catalog semantics the platform has always had, kept *inside* the tenant:
 *   what the tenant boundary reverses is who is in the room, not how open the
 *   room is.
 * - `editor` — a viewer who may also create projects and write their own.
 * - `admin` — an editor who may write anyone's project, mutate the shared
 *   registries (skills, MCP servers, external agents), and change settings.
 *
 * Project *ownership* is a separate axis and stays on the project
 * (`ownerEmail`): a role says what someone may do in the tenant, ownership says
 * whose thing it is.
 */
export type OrganizationRole = "viewer" | "editor" | "admin";

/** Ordered by capability, so a check reads as "at least this". */
const RANK: Record<OrganizationRole, number> = { viewer: 0, editor: 1, admin: 2 };

export function isRole(value: string): value is OrganizationRole {
  return value in RANK;
}

/** True when `role` carries at least `required`'s capabilities. */
export function hasRole(role: OrganizationRole, required: OrganizationRole): boolean {
  return RANK[role] >= RANK[required];
}

export interface Membership {
  organizationId: string;
  userEmail: string;
  role: OrganizationRole;
  createdAt: string;
  updatedAt: string;
}
