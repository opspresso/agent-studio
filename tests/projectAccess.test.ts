import { beforeEach, describe, expect, it } from "vitest";

import type { Project } from "@/domain/project/types";
import type { ProjectRepository } from "@/domain/project/repository";
import {
  isProjectPrivate,
  mayAccessProject,
  normalizeMemberEmails,
} from "@/domain/project/access";
import {
  assertProjectAccessible,
  listAccessibleProjects,
  setAdminCheck,
  updateProject,
} from "@/application/project/projectUseCases";
import { ForbiddenError, NotFoundError } from "@/application/errors";

const OWNER = "owner@x.com";
const MEMBER = "member@x.com";
const STRANGER = "stranger@x.com";
const ADMIN = "admin@x.com";

// Wired exactly as the composition root does; default empty, like a deployment
// that never set ADMIN_EMAILS.
const admins = { emails: [] as string[] };
setAdminCheck(async (email: string) => admins.emails.includes(email.toLowerCase()));
beforeEach(() => {
  admins.emails = [];
});

function project(overrides: Partial<Project> = {}): Project {
  return {
    name: "proj",
    displayName: "Proj",
    description: "",
    projectType: "agent",
    ownerEmail: OWNER,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** In-memory repository over the methods these use cases reach. */
function fakeRepo(projects: Project[]): ProjectRepository {
  const byName = new Map(projects.map((p) => [p.name, p]));
  return {
    get: async (name) => byName.get(name) ?? null,
    list: async () => [...byName.values()],
    create: async (p) => void byName.set(p.name, p),
    update: async (p) => void byName.set(p.name, p),
    publish: async () => {
      throw new Error("not used");
    },
    delete: async (name) => void byName.delete(name),
    getApiToken: async () => null,
    setApiToken: async () => {},
    deleteApiToken: async () => {},
  };
}

describe("mayAccessProject", () => {
  it("treats an absent visibility as public", () => {
    expect(isProjectPrivate(project())).toBe(false);
    expect(mayAccessProject(project(), STRANGER)).toBe(true);
  });

  it("lets anyone into an explicitly public project", () => {
    expect(mayAccessProject(project({ visibility: "public" }), STRANGER)).toBe(true);
  });

  it("keeps a stranger out of a private project", () => {
    expect(mayAccessProject(project({ visibility: "private" }), STRANGER)).toBe(false);
  });

  it("always admits the owner, case-insensitively", () => {
    const p = project({ visibility: "private", ownerEmail: "Owner@X.com" });
    expect(mayAccessProject(p, "owner@x.com")).toBe(true);
  });

  it("admits an invited member, case-insensitively", () => {
    const p = project({ visibility: "private", memberEmails: [MEMBER] });
    expect(mayAccessProject(p, "Member@X.com")).toBe(true);
    expect(mayAccessProject(p, STRANGER)).toBe(false);
  });

  it("ignores the invite list while the project is public", () => {
    const p = project({ memberEmails: [MEMBER] });
    expect(mayAccessProject(p, STRANGER)).toBe(true);
  });
});

describe("normalizeMemberEmails", () => {
  it("trims, lowercases, dedupes, and drops the owner and empties", () => {
    expect(
      normalizeMemberEmails(
        ["  A@x.com ", "a@x.com", "b@x.com", OWNER.toUpperCase(), "   "],
        OWNER,
      ),
    ).toEqual(["a@x.com", "b@x.com"]);
  });
});

describe("assertProjectAccessible", () => {
  const repos = () =>
    fakeRepo([
      project(),
      project({ name: "secret", visibility: "private", memberEmails: [MEMBER] }),
    ]);

  it("404s an unknown project", async () => {
    await expect(assertProjectAccessible(repos(), "nope", STRANGER)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("admits anyone to a public project", async () => {
    await expect(assertProjectAccessible(repos(), "proj", STRANGER)).resolves.toMatchObject({
      name: "proj",
    });
  });

  it("403s a stranger on a private project", async () => {
    await expect(assertProjectAccessible(repos(), "secret", STRANGER)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("admits the owner and an invited member to a private project", async () => {
    await expect(assertProjectAccessible(repos(), "secret", OWNER)).resolves.toBeDefined();
    await expect(assertProjectAccessible(repos(), "secret", MEMBER)).resolves.toBeDefined();
  });

  it("admits a configured admin to a private project", async () => {
    admins.emails = [ADMIN];
    await expect(assertProjectAccessible(repos(), "secret", ADMIN)).resolves.toBeDefined();
  });
});

describe("listAccessibleProjects", () => {
  const repos = () =>
    fakeRepo([
      project(),
      project({ name: "mine", visibility: "private", ownerEmail: STRANGER }),
      project({ name: "invited", visibility: "private", memberEmails: [STRANGER] }),
      project({ name: "hidden", visibility: "private" }),
    ]);

  it("returns public projects plus the private ones owned or invited", async () => {
    const names = (await listAccessibleProjects(repos(), STRANGER)).map((p) => p.name).sort();
    expect(names).toEqual(["invited", "mine", "proj"]);
  });

  it("returns everything to a configured admin", async () => {
    admins.emails = [ADMIN];
    const names = (await listAccessibleProjects(repos(), ADMIN)).map((p) => p.name).sort();
    expect(names).toEqual(["hidden", "invited", "mine", "proj"]);
  });
});

describe("updateProject visibility", () => {
  it("stores visibility and the normalized invite list", async () => {
    const repo = fakeRepo([project()]);
    const updated = await updateProject(
      repo,
      "proj",
      { visibility: "private", memberEmails: [" Member@X.com ", OWNER] },
      OWNER,
    );
    expect(updated.visibility).toBe("private");
    expect(updated.memberEmails).toEqual([MEMBER]);
  });

  it("keeps both fields when the update does not mention them", async () => {
    const repo = fakeRepo([
      project({ visibility: "private", memberEmails: [MEMBER] }),
    ]);
    const updated = await updateProject(repo, "proj", { description: "new" }, OWNER);
    expect(updated.visibility).toBe("private");
    expect(updated.memberEmails).toEqual([MEMBER]);
  });
});
