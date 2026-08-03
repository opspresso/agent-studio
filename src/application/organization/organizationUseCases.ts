/**
 * Registering workspaces, and saying who is in them.
 *
 * Until this existed the tenant scheme was reachable only by writing DynamoDB
 * rows by hand: every key builder took a tenant, `withAuth` entered the
 * caller's scope, roles decided what they could do — and nothing in the product
 * could create the organization or the membership those depend on. The whole
 * mechanism was inert.
 *
 * Two different authorities, which is why they are separate operations rather
 * than one CRUD surface:
 *
 * - **Registering a workspace is a deployment-level act.** The id becomes a key
 *   prefix every row of that tenant carries, so creating one changes what the
 *   installation *is*. A workspace admin is an admin of theirs, not of the
 *   deployment, and must not be able to mint another.
 * - **Managing members is the workspace's own.** Its admins decide who is in
 *   the room; the deployment's operators can too, because someone has to be
 *   able to reach a workspace whose last admin left.
 */

import type { Membership, OrganizationRole } from "@/domain/organization/membership";
import type {
  MembershipRepository,
  OrganizationRepository,
} from "@/domain/organization/repository";
import type { AuditEventInput } from "@/domain/audit/types";
import type { Organization } from "@/domain/organization/types";
import { isRole } from "@/domain/organization/membership";
import { recordAudit } from "@/application/audit/auditLog";
import { ConflictError, NotFoundError, ValidationError, isConditionalWriteFailure } from "@/application/errors";
import { DEFAULT_TENANT, withTenant } from "@/shared/tenantContext";
import { isSlug, SLUG_RULE } from "@/shared/slug";

export interface OrganizationUseCases {
  list(): Promise<Organization[]>;
  create(input: { id: string; displayName: string }, userEmail: string): Promise<Organization>;
  rename(id: string, displayName: string): Promise<Organization>;
  remove(id: string, userEmail: string): Promise<void>;
  listMembers(organizationId: string): Promise<Membership[]>;
  setMember(
    organizationId: string,
    userEmail: string,
    role: OrganizationRole,
    actorEmail: string,
  ): Promise<Membership>;
  removeMember(organizationId: string, userEmail: string, actorEmail: string): Promise<void>;
}

/**
 * Record an act **against the workspace it was about**, not the one the actor
 * happens to be acting in.
 *
 * Audit rows are tenant-scoped like everything else, and `withAuth` enters the
 * *caller's* workspace. A deployment operator managing `acme` is in the default
 * one, so without this every membership change they made landed in a partition
 * `acme`'s admins cannot read — leaving a workspace's trail silently incomplete
 * for exactly the acts an outsider performed on it.
 *
 * `organization.delete` is the deliberate exception and stays with the actor:
 * the workspace's own partition is about to have no readers, so a row there is
 * a record nobody can reach.
 */
function recordFor(organizationId: string, event: AuditEventInput): Promise<void> {
  return withTenant(organizationId, () => recordAudit(event));
}

/** An address is stored lowercased, because that is how every lookup spells it. */
function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new ValidationError("A member needs an email address");
  }
  return email;
}

async function requireOrganization(
  repo: OrganizationRepository,
  id: string,
): Promise<Organization> {
  const organization = await repo.get(id);
  if (!organization) {
    throw new NotFoundError(`Workspace '${id}' not found`);
  }
  return organization;
}

export function createOrganizationUseCases(
  organizations: OrganizationRepository,
  memberships: MembershipRepository,
  now: () => Date = () => new Date(),
): OrganizationUseCases {
  return {
    list() {
      return organizations.list();
    },

    async create(input, userEmail) {
      const id = input.id.trim().toLowerCase();
      if (!isSlug(id)) {
        // The id *is* the key prefix, so this is not a cosmetic rule: anything
        // else produces keys nothing else in the app can address.
        throw new ValidationError(`Workspace id ${SLUG_RULE}`);
      }
      if (id === DEFAULT_TENANT) {
        throw new ValidationError(
          `'${DEFAULT_TENANT}' is the unprefixed workspace every deployment already is`,
        );
      }
      const displayName = input.displayName.trim() || id;
      const timestamp = now().toISOString();
      const organization: Organization = {
        id,
        displayName,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      try {
        await organizations.create(organization);
      } catch (error) {
        if (isConditionalWriteFailure(error)) {
          throw new ConflictError(`Workspace '${id}' already exists`);
        }
        throw error;
      }

      /*
       * The creator becomes its admin, in the same call. A workspace with no
       * members is one nobody can administer: its own settings page and member
       * list are gated on a membership role, and the only way back in would be
       * the row-writing this use case exists to replace.
       */
      const membership: Membership = {
        organizationId: id,
        userEmail: normalizeEmail(userEmail),
        role: "admin",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await memberships.put(membership);

      await recordFor(id, {
        action: "organization.create",
        actorEmail: userEmail,
        target: `organization:${id}`,
        detail: `first admin: ${membership.userEmail}`,
      });
      return organization;
    },

    async rename(id, displayName) {
      const existing = await requireOrganization(organizations, id);
      const name = displayName.trim();
      if (!name) {
        throw new ValidationError("A workspace needs a display name");
      }
      // Only the display name: the id is a key prefix, so renaming one would
      // orphan every row written under the old name.
      const updated: Organization = { ...existing, displayName: name, updatedAt: now().toISOString() };
      await organizations.update(updated);
      return updated;
    },

    async remove(id, userEmail) {
      await requireOrganization(organizations, id);
      const members = await memberships.listByOrganization(id);
      for (const member of members) {
        await memberships.delete(id, member.userEmail);
      }
      await organizations.delete(id);
      // The rows are the part this cannot do: they are spread across every
      // partition prefix, so removing them is a sweep rather than a cascade.
      // The audit row is what says they are still there.
      await recordAudit({
        action: "organization.delete",
        actorEmail: userEmail,
        target: `organization:${id}`,
        detail: `${members.length} membership(s) removed; the workspace's own rows were left in place`,
      });
    },

    async listMembers(organizationId) {
      await requireOrganization(organizations, organizationId);
      return memberships.listByOrganization(organizationId);
    },

    async setMember(organizationId, userEmail, role, actorEmail) {
      await requireOrganization(organizations, organizationId);
      if (!isRole(role)) {
        throw new ValidationError(`Unknown role '${role}'`);
      }
      const email = normalizeEmail(userEmail);
      const existing = await memberships.get(organizationId, email);
      if (existing && existing.role === "admin" && role !== "admin") {
        // Demoting the last admin leaves a workspace nobody can administer,
        // which is the same dead end an empty membership list is.
        const admins = (await memberships.listByOrganization(organizationId)).filter(
          (member) => member.role === "admin",
        );
        if (admins.length <= 1) {
          throw new ValidationError(
            "A workspace needs at least one admin; promote someone else first",
          );
        }
      }
      const timestamp = now().toISOString();
      const membership: Membership = {
        organizationId,
        userEmail: email,
        role,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      await memberships.put(membership);
      await recordFor(organizationId, {
        action: "membership.grant",
        actorEmail,
        target: `organization:${organizationId}`,
        detail: `${email} → ${role}`,
      });
      return membership;
    },

    async removeMember(organizationId, userEmail, actorEmail) {
      await requireOrganization(organizations, organizationId);
      const email = normalizeEmail(userEmail);
      const existing = await memberships.get(organizationId, email);
      if (!existing) {
        throw new NotFoundError(`${email} is not a member of '${organizationId}'`);
      }
      if (existing.role === "admin") {
        const admins = (await memberships.listByOrganization(organizationId)).filter(
          (member) => member.role === "admin",
        );
        if (admins.length <= 1) {
          throw new ValidationError(
            "A workspace needs at least one admin; promote someone else first",
          );
        }
      }
      await memberships.delete(organizationId, email);
      await recordFor(organizationId, {
        action: "membership.revoke",
        actorEmail,
        target: `organization:${organizationId}`,
        detail: email,
      });
    },
  };
}
