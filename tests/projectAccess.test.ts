process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

import { beforeEach, describe, expect, it } from "vitest";

import type { Project, Version } from "@/domain/project/types";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
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
import { createVersion, updateVersion, type VersionRefRepos } from "@/application/project/versionUseCases";
import { sanitizeProject } from "@/app/api/projects/_lib/http";
import { ForbiddenError, NotFoundError, ValidationError } from "@/application/errors";

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

describe("sanitizeProject and the invite list", () => {
  it("strips memberEmails unless the viewer manages the project", () => {
    const p = project({ visibility: "private", memberEmails: [MEMBER] });
    expect(sanitizeProject(p)).not.toHaveProperty("memberEmails");
    expect(sanitizeProject(p, { withMemberEmails: true }).memberEmails).toEqual([MEMBER]);
    // Visibility itself stays: the list badge and settings form read it.
    expect(sanitizeProject(p).visibility).toBe("private");
  });
});

describe("binding a private project as a local subagent", () => {
  const EDITOR = MEMBER;

  function versionRepos() {
    const stored: Version[] = [];
    return {
      stored,
      versions: {
        list: async (projectName: string) => stored.filter((v) => v.projectName === projectName),
        create: async (version: Version) => void stored.push(version),
        get: async (projectName: string, versionName: string) =>
          stored.find((v) => v.projectName === projectName && v.versionName === versionName) ??
          null,
        put: async (version: Version) => {
          const at = stored.findIndex(
            (v) => v.projectName === version.projectName && v.versionName === version.versionName,
          );
          stored[at] = version;
        },
      } as unknown as VersionRepository,
    };
  }

  function accessRefs(subagent: Project): VersionRefRepos {
    return {
      skills: { get: async () => null },
      mcps: { get: async () => null },
      externalAgents: { get: async () => null },
      projects: { get: async () => subagent },
    } as unknown as VersionRefRepos;
  }

  const input = {
    systemPrompt: "",
    userPromptTemplate: "",
    model: "openai/gpt-5-mini",
    parameters: { piiFiltering: false },
    mcpList: [],
    skillList: [],
    subagentList: [{ name: "secret", type: "local" as const }],
  };

  async function cipher() {
    return (await import("@/infrastructure/crypto/secretCipher")).secretCipher;
  }

  it("refuses an editor the subagent project keeps out", async () => {
    const repo = fakeRepo([project({ name: "mine", projectType: "agent", ownerEmail: EDITOR })]);
    const { versions } = versionRepos();
    const secret = project({ name: "secret", visibility: "private" });
    await expect(
      createVersion(versions, repo, "mine", input, EDITOR, accessRefs(secret), await cipher()),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("lets an invited editor bind it", async () => {
    const repo = fakeRepo([project({ name: "mine", projectType: "agent", ownerEmail: EDITOR })]);
    const { versions, stored } = versionRepos();
    const secret = project({ name: "secret", visibility: "private", memberEmails: [EDITOR] });
    await createVersion(versions, repo, "mine", input, EDITOR, accessRefs(secret), await cipher());
    expect(stored[0]?.subagentList).toEqual([{ name: "secret", type: "local" }]);
  });

  it("keeps a version editable after a bound project went private", async () => {
    const repo = fakeRepo([project({ name: "mine", projectType: "agent", ownerEmail: EDITOR })]);
    const { versions, stored } = versionRepos();
    const secret = project({ name: "secret", visibility: "private" });
    stored.push({
      projectName: "mine",
      versionName: "1",
      systemPrompt: "",
      userPromptTemplate: "",
      model: "openai/gpt-5-mini",
      parameters: { piiFiltering: false },
      mcpList: [],
      skillList: [],
      subagentList: [{ name: "secret", type: "local" }],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    // The ref is already on the version, so editing the prompt keeps it.
    const updated = await updateVersion(
      versions,
      repo,
      "mine",
      "1",
      { systemPrompt: "new", subagentList: [{ name: "secret", type: "local" }] },
      EDITOR,
      accessRefs(secret),
      await cipher(),
    );
    expect(updated.systemPrompt).toBe("new");
  });
});
