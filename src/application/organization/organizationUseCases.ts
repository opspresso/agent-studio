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
import { normalizeEmail } from "@/shared/email";
import { isSlug, SLUG_RULE } from "@/shared/slug";
import { log } from "@/shared/logger";

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

/** An address, spelled the way every lookup spells it. */
function requireEmail(value: string): string {
  const email = normalizeEmail(value);
  if (!email || !email.includes("@")) {
    throw new ValidationError("A member needs an email address");
  }
  return email;
}

/**
 * Refuse to put someone in a second workspace.
 *
 * `resolveWorkspace` gives a person one workspace and picks the first by id
 * when they are in several, so a second membership does not add anything — it
 * *moves* them, and possibly out of the one they have been working in. That
 * makes granting a membership an act on a workspace the granting admin may not
 * administer at all: adding a `zeta` member to `acme` takes their projects,
 * chats and settings out from under them within the resolution cache's TTL,
 * with no workspace switcher to get back.
 *
 * So the write refuses while the product has one workspace per person. Lifting
 * this is what a switcher would be for; until then the constraint is the honest
 * shape of what the reader can express.
 */
async function assertNotInAnotherWorkspace(
  memberships: MembershipRepository,
  email: string,
  organizationId: string,
): Promise<void> {
  const held = await memberships.listByUser(email);
  const elsewhere = held.find((membership) => membership.organizationId !== organizationId);
  if (elsewhere) {
    throw new ConflictError(
      `${email} is already a member of '${elsewhere.organizationId}'. ` +
        `Remove them there first — a person belongs to one workspace.`,
    );
  }
}

const NEEDS_AN_ADMIN = "A workspace needs at least one admin; promote someone else first";

/** How many admins a workspace has right now. */
async function countAdmins(
  memberships: MembershipRepository,
  organizationId: string,
): Promise<number> {
  const members = await memberships.listByOrganization(organizationId);
  return members.filter((member) => member.role === "admin").length;
}

/**
 * Confirm the write that just happened left an admin behind, and undo it if it
 * did not.
 *
 * The rule cannot be a conditional write: "someone *else* is still an admin" is
 * a statement about other items, and DynamoDB conditions a write on the item it
 * is writing. So it is checked before — which is what produces the useful error
 * — and confirmed after, which is what closes the window where two demotions
 * both saw two admins and each left one.
 *
 * Two racing writers can both undo themselves. That is the safe direction: the
 * failure this exists to prevent is a workspace with no admin, and the worst
 * case here is a workspace that still has both.
 */
async function confirmAnAdminRemains(
  memberships: MembershipRepository,
  organizationId: string,
  undo: () => Promise<void>,
): Promise<void> {
  if ((await countAdmins(memberships, organizationId)) > 0) {
    return;
  }
  await undo();
  throw new ValidationError(NEEDS_AN_ADMIN);
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
      // Before the record exists, because the creator becomes its first admin
      // and that membership would move them out of the workspace they are in.
      const creatorEmail = requireEmail(userEmail);
      await assertNotInAnotherWorkspace(memberships, creatorEmail, id);
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
        userEmail: creatorEmail,
        role: "admin",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      try {
        await memberships.put(membership);
      } catch (error) {
        // Rolled back rather than left: the organization row alone is a
        // workspace nobody can administer *and* one nobody can re-create,
        // because the id is claimed and the create is conditional — a 409
        // forever on the only thing that would have fixed it.
        try {
          await organizations.delete(id);
        } catch (rollbackError) {
          log.error(
            "authz",
            `could not roll back workspace '${id}' after its first membership failed; ` +
              `it exists with no members and must be removed by hand`,
            rollbackError,
          );
        }
        throw error;
      }

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
      // Fenced per member, and the loop finishes: the operator's intent is that
      // the workspace goes, so getting as far as possible leaves a retry less to
      // do. What must not happen is the record going while memberships remain —
      // that is a workspace nobody can see and members still pointing at it.
      const failed: string[] = [];
      for (const member of members) {
        try {
          await memberships.delete(id, member.userEmail);
        } catch (error) {
          log.error("authz", `could not remove ${member.userEmail} from '${id}'`, error);
          failed.push(member.userEmail);
        }
      }
      if (failed.length > 0) {
        throw new ConflictError(
          `Removed ${members.length - failed.length} of ${members.length} memberships of '${id}'; ` +
            `${failed.join(", ")} could not be removed, so the workspace record was kept. Retry.`,
        );
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
      const email = requireEmail(userEmail);
      const existing = await memberships.get(organizationId, email);
      if (!existing) {
        await assertNotInAnotherWorkspace(memberships, email, organizationId);
      }
      // Demoting the last admin leaves a workspace nobody can administer, which
      // is the same dead end an empty membership list is.
      const demotesAnAdmin = existing?.role === "admin" && role !== "admin";
      if (demotesAnAdmin && (await countAdmins(memberships, organizationId)) <= 1) {
        throw new ValidationError(NEEDS_AN_ADMIN);
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
      if (demotesAnAdmin) {
        await confirmAnAdminRemains(memberships, organizationId, () =>
          memberships.put(existing!),
        );
      }
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
      const email = requireEmail(userEmail);
      const existing = await memberships.get(organizationId, email);
      if (!existing) {
        throw new NotFoundError(`${email} is not a member of '${organizationId}'`);
      }
      const removesAnAdmin = existing.role === "admin";
      if (removesAnAdmin && (await countAdmins(memberships, organizationId)) <= 1) {
        throw new ValidationError(NEEDS_AN_ADMIN);
      }
      await memberships.delete(organizationId, email);
      if (removesAnAdmin) {
        await confirmAnAdminRemains(memberships, organizationId, () => memberships.put(existing));
      }
      await recordFor(organizationId, {
        action: "membership.revoke",
        actorEmail,
        target: `organization:${organizationId}`,
        detail: email,
      });
    },
  };
}
