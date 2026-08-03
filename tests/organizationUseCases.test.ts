/**
 * Registering workspaces and their members.
 *
 * The rules worth pinning are the ones that make a workspace *reachable*: an id
 * that can be a key prefix, a creator who is left able to administer what they
 * made, and an admin who cannot be removed while they are the last one. Each of
 * those failing leaves a workspace whose only remaining door is writing
 * DynamoDB rows by hand, which is what this use case exists to replace.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEventInput } from "@/domain/audit/types";
import type { Membership, OrganizationRole } from "@/domain/organization/membership";
import type { Organization } from "@/domain/organization/types";
import { createOrganizationUseCases } from "@/application/organization/organizationUseCases";
import { setAuditSink } from "@/application/audit/auditLog";
import { ConflictError, NotFoundError, ValidationError } from "@/application/errors";
import { currentTenant, DEFAULT_TENANT, withTenant } from "@/shared/tenantContext";

const NOW = new Date("2026-08-03T00:00:00.000Z");

const organizations = new Map<string, Organization>();
const memberships = new Map<string, Membership>();
/** The tenant each row would be keyed under, which is the whole of the fix below. */
const audit: (AuditEventInput & { tenant: string })[] = [];

const key = (organizationId: string, email: string) => `${organizationId}|${email}`;

const member = (
  userEmail: string,
  organizationId: string,
  role: OrganizationRole,
): Membership => ({
  organizationId,
  userEmail,
  role,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
});

class ConditionalCheckFailedException extends Error {
  constructor() {
    super("The conditional request failed");
    this.name = "ConditionalCheckFailedException";
  }
}

/** Named so a case can make one call fail and watch what the use case does about it. */
const repos = {
  organizations: {
    get: async (id: string) => organizations.get(id) ?? null,
    list: async () => [...organizations.values()],
    create: async (organization: Organization) => {
      if (organizations.has(organization.id)) {
        // The real repository writes with `attribute_not_exists(PK)`; the id is
        // a key prefix, so a lost race merges two tenants into one namespace.
        throw new ConditionalCheckFailedException();
      }
      organizations.set(organization.id, organization);
    },
    update: async (organization: Organization) => {
      organizations.set(organization.id, organization);
    },
    delete: async (id: string) => {
      organizations.delete(id);
    },
  },
  memberships: {
    get: async (organizationId: string, email: string) =>
      memberships.get(key(organizationId, email)) ?? null,
    listByOrganization: async (organizationId: string) =>
      [...memberships.values()].filter((row) => row.organizationId === organizationId),
    listByUser: async (email: string) =>
      [...memberships.values()].filter((row) => row.userEmail === email),
    put: async (membership: Membership) => {
      memberships.set(key(membership.organizationId, membership.userEmail), membership);
    },
    delete: async (organizationId: string, email: string) => {
      memberships.delete(key(organizationId, email));
    },
  },
};

const useCases = createOrganizationUseCases(repos.organizations, repos.memberships, () => NOW);

beforeEach(() => {
  organizations.clear();
  memberships.clear();
  audit.length = 0;
  setAuditSink(async (event) => {
    // The real sink keys on `currentTenant()`, so recording it here is what
    // makes "which workspace's log does this land in" assertable.
    audit.push({ ...event, tenant: currentTenant() });
  });
});

describe("registering a workspace", () => {
  it("makes the creator its admin, so it is not born unmanageable", async () => {
    // A workspace with no members has no one who can add one: its member list
    // and settings are both gated on a membership role.
    await useCases.create({ id: "acme", displayName: "Acme" }, "Boss@Example.com");
    expect(await useCases.listMembers("acme")).toEqual([
      expect.objectContaining({ userEmail: "boss@example.com", role: "admin" }),
    ]);
  });

  it("takes only an id that can be a key prefix", async () => {
    await expect(useCases.create({ id: "Acme Inc", displayName: "" }, "a@x.com")).rejects.toThrow(
      ValidationError,
    );
    await expect(useCases.create({ id: "", displayName: "" }, "a@x.com")).rejects.toThrow(
      ValidationError,
    );
  });

  it("refuses the name the unprefixed workspace already answers to", async () => {
    await expect(useCases.create({ id: "default", displayName: "" }, "a@x.com")).rejects.toThrow(
      ValidationError,
    );
  });

  it("turns a lost race into a conflict, not a merge", async () => {
    await useCases.create({ id: "acme", displayName: "Acme" }, "a@x.com");
    await expect(useCases.create({ id: "acme", displayName: "Other" }, "b@x.com")).rejects.toThrow(
      ConflictError,
    );
    expect(organizations.get("acme")?.displayName).toBe("Acme");
  });

  it("falls back to the id when no display name is given", async () => {
    const created = await useCases.create({ id: "acme", displayName: "  " }, "a@x.com");
    expect(created.displayName).toBe("acme");
  });

  it("rolls the workspace back when its first membership cannot be written", async () => {
    // Left in place it is a workspace nobody can administer *and* nobody can
    // re-create: the id is claimed and the create is conditional, so the only
    // thing that would have fixed it answers 409 forever.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const put = vi.spyOn(repos.memberships, "put").mockRejectedValueOnce(new Error("throttled"));
    await expect(useCases.create({ id: "acme", displayName: "Acme" }, "a@x.com")).rejects.toThrow(
      "throttled",
    );
    expect(organizations.size).toBe(0);
    // And the id is free again.
    put.mockRestore();
    await expect(
      useCases.create({ id: "acme", displayName: "Acme" }, "a@x.com"),
    ).resolves.toMatchObject({ id: "acme" });
    error.mockRestore();
  });

  it("will not register one for someone who is already in another", async () => {
    // The creator becomes the new workspace's admin, which is a membership like
    // any other — so registering one would move them out of the workspace they
    // are working in, and the record would be created before anything noticed.
    await useCases.create({ id: "zeta", displayName: "Zeta" }, "her@x.com");
    await expect(useCases.create({ id: "acme", displayName: "Acme" }, "her@x.com")).rejects.toThrow(
      ConflictError,
    );
    expect(organizations.has("acme")).toBe(false);
  });

  it("records who registered it and who can administer it", async () => {
    await useCases.create({ id: "acme", displayName: "Acme" }, "boss@x.com");
    expect(audit).toEqual([
      expect.objectContaining({
        action: "organization.create",
        actorEmail: "boss@x.com",
        target: "organization:acme",
        detail: "first admin: boss@x.com",
      }),
    ]);
  });
});

describe("members", () => {
  beforeEach(async () => {
    await useCases.create({ id: "acme", displayName: "Acme" }, "boss@x.com");
    audit.length = 0;
  });

  it("adds one, lowercasing the address every lookup spells that way", async () => {
    const membership = await useCases.setMember("acme", " Her@X.com ", "editor", "boss@x.com");
    expect(membership.userEmail).toBe("her@x.com");
    expect(await useCases.listMembers("acme")).toHaveLength(2);
  });

  it("changes a role in place, keeping when they joined", async () => {
    await useCases.setMember("acme", "her@x.com", "viewer", "boss@x.com");
    const promoted = await useCases.setMember("acme", "her@x.com", "admin", "boss@x.com");
    expect(promoted.role).toBe("admin");
    expect(await useCases.listMembers("acme")).toHaveLength(2);
  });

  it("will not leave a workspace without an admin", async () => {
    // Both doors to the same dead end: demoting the last admin and removing
    // them. Either would leave a workspace nobody can administer.
    await expect(useCases.setMember("acme", "boss@x.com", "editor", "boss@x.com")).rejects.toThrow(
      ValidationError,
    );
    await expect(useCases.removeMember("acme", "boss@x.com", "boss@x.com")).rejects.toThrow(
      ValidationError,
    );

    await useCases.setMember("acme", "her@x.com", "admin", "boss@x.com");
    await useCases.removeMember("acme", "boss@x.com", "her@x.com");
    expect(await useCases.listMembers("acme")).toEqual([
      expect.objectContaining({ userEmail: "her@x.com", role: "admin" }),
    ]);
  });

  it("puts back a demotion that turns out to have taken the last admin", async () => {
    // Two demotions racing both pass the pre-check, because each sees the other
    // still there. The rule cannot be a conditional write — "someone *else* is
    // an admin" is a statement about other items — so it is confirmed after,
    // and a write that emptied the set is undone.
    await useCases.setMember("acme", "her@x.com", "admin", "boss@x.com");
    const listByOrganization = vi
      .spyOn(repos.memberships, "listByOrganization")
      // The pre-check sees two admins (the race's other writer has not landed);
      // by the post-check it has, and this one took the last.
      .mockImplementationOnce(async () => [
        { ...member("boss@x.com", "acme", "admin") },
        { ...member("her@x.com", "acme", "admin") },
      ])
      .mockImplementationOnce(async () => []);

    await expect(useCases.setMember("acme", "boss@x.com", "editor", "boss@x.com")).rejects.toThrow(
      ValidationError,
    );
    listByOrganization.mockRestore();
    // Undone: the demotion is not left standing on a workspace with no admin.
    expect((await useCases.listMembers("acme")).find((m) => m.userEmail === "boss@x.com")?.role).toBe(
      "admin",
    );
  });

  it("will not move someone into a second workspace", async () => {
    // `resolveWorkspace` gives a person one workspace and breaks a tie by id,
    // so a second membership does not add — it *moves*. Without this, an admin
    // of a low-sorting workspace could take any address they knew: on that
    // person's next request their projects, chats and settings are gone, with
    // no switcher to get back.
    await useCases.create({ id: "zeta", displayName: "Zeta" }, "her@x.com");
    await expect(useCases.setMember("acme", "Her@X.com", "viewer", "boss@x.com")).rejects.toThrow(
      /already a member of 'zeta'/,
    );
    expect(await useCases.listMembers("acme")).toHaveLength(1);
  });

  it("still lets a workspace change its own member's role", async () => {
    // The rule is about a *second* workspace, not about touching a member.
    await useCases.setMember("acme", "her@x.com", "viewer", "boss@x.com");
    await expect(
      useCases.setMember("acme", "her@x.com", "editor", "boss@x.com"),
    ).resolves.toMatchObject({ role: "editor" });
  });

  it("refuses to touch a workspace that does not exist", async () => {
    await expect(useCases.listMembers("nope")).rejects.toThrow(NotFoundError);
    await expect(useCases.setMember("nope", "a@x.com", "viewer", "b@x.com")).rejects.toThrow(
      NotFoundError,
    );
  });

  it("refuses to remove someone who was never a member", async () => {
    await expect(useCases.removeMember("acme", "nobody@x.com", "boss@x.com")).rejects.toThrow(
      NotFoundError,
    );
  });

  it("writes the trail into the workspace it is about, not the actor's", async () => {
    // A deployment operator manages `acme` from the default workspace. Keying
    // the row on the actor's tenant put it where `acme`'s admins cannot read
    // it — losing exactly the acts an outsider performed on them.
    await withTenant(DEFAULT_TENANT, () =>
      useCases.setMember("acme", "outsider@x.com", "editor", "operator@x.com"),
    );
    expect(audit).toEqual([expect.objectContaining({ action: "membership.grant", tenant: "acme" })]);
  });

  it("records each grant and revoke against the workspace", async () => {
    await useCases.setMember("acme", "her@x.com", "editor", "boss@x.com");
    await useCases.removeMember("acme", "her@x.com", "boss@x.com");
    expect(audit).toEqual([
      expect.objectContaining({
        action: "membership.grant",
        actorEmail: "boss@x.com",
        target: "organization:acme",
        detail: "her@x.com → editor",
      }),
      expect.objectContaining({
        action: "membership.revoke",
        actorEmail: "boss@x.com",
        target: "organization:acme",
        detail: "her@x.com",
      }),
    ]);
  });
});

describe("removing a workspace", () => {
  beforeEach(async () => {
    await useCases.create({ id: "acme", displayName: "Acme" }, "boss@x.com");
    await useCases.setMember("acme", "her@x.com", "viewer", "boss@x.com");
    audit.length = 0;
  });

  it("takes the record and the memberships, and says what it left", async () => {
    // Deliberately not a cascade: the workspace's rows are spread across every
    // partition prefix, so removing them is a sweep somebody has to mean.
    await withTenant(DEFAULT_TENANT, () => useCases.remove("acme", "boss@x.com"));
    expect(organizations.size).toBe(0);
    expect(memberships.size).toBe(0);
    expect(audit).toEqual([
      expect.objectContaining({
        action: "organization.delete",
        target: "organization:acme",
        detail: expect.stringContaining("left in place"),
        // The one act recorded against the actor: `acme`'s own partition is
        // about to have no readers, so a row there is one nobody can reach.
        tenant: DEFAULT_TENANT,
      }),
    ]);
  });

  it("keeps the record when a membership cannot be removed, and says what is left", async () => {
    // The record going while memberships remain is the state nobody can fix
    // from the console: a workspace that is invisible, with members still
    // pointing at it. A retry finishes the job — removing an absent membership
    // is a no-op.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const remove = vi
      .spyOn(repos.memberships, "delete")
      .mockRejectedValueOnce(new Error("throttled"));
    await expect(useCases.remove("acme", "boss@x.com")).rejects.toThrow(ConflictError);
    expect(organizations.has("acme")).toBe(true);
    remove.mockRestore();
    error.mockRestore();

    await withTenant(DEFAULT_TENANT, () => useCases.remove("acme", "boss@x.com"));
    expect(organizations.size).toBe(0);
    expect(memberships.size).toBe(0);
  });
});

describe("roles", () => {
  it("does not mistake an inherited property for a role", async () => {
    // `"constructor" in RANK` is true, so an `in` test let one past every guard
    // and left a member whose rank is `undefined` — satisfying no check and
    // impossible to reason about.
    await useCases.create({ id: "acme", displayName: "Acme" }, "boss@x.com");
    for (const notARole of ["constructor", "toString", "valueOf", "owner"]) {
      await expect(
        useCases.setMember("acme", "her@x.com", notARole as OrganizationRole, "boss@x.com"),
      ).rejects.toThrow(ValidationError);
    }
  });
});

describe("renaming", () => {
  it("changes the display name and never the id", async () => {
    await useCases.create({ id: "acme", displayName: "Acme" }, "boss@x.com");
    const renamed = await useCases.rename("acme", "Acme Corporation");
    expect(renamed).toMatchObject({ id: "acme", displayName: "Acme Corporation" });
    await expect(useCases.rename("acme", "   ")).rejects.toThrow(ValidationError);
  });
});
