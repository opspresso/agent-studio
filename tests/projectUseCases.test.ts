// MCP header overrides are encrypted at rest, so the key must be present before
// the encryption module reads config.
process.env.AES_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Project mutation is "owner or admin", so these cases have to be able to say
 * which. Default: no admin configured, which is what every ownership case below
 * assumes and what a deployment that never set ADMIN_EMAILS has. Wired through
 * `setAdminCheck` exactly as the composition root does it.
 */
const admins = { emails: [] as string[] };
const adminListCheck = async (email: string) => admins.emails.includes(email.toLowerCase());
setAdminCheck(adminListCheck);
beforeEach(() => {
  admins.emails = [];
});
import type { Project, Version } from "@/domain/project/types";
import type { FakeStore } from "./fakeStore";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type {
  CreateVersionInput,
  UpdateVersionInput,
  VersionInput,
  VersionRefRepos,
} from "@/application/project/versionUseCases";
import {
  createVersion as createVersionUseCase,
  deleteVersion,
  listVersions,
  publishVersion,
  toVersionView as toVersionViewUseCase,
  updateVersion as updateVersionUseCase,
} from "@/application/project/versionUseCases";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import {
  decryptSecret,
  isEncrypted,
  isMasked,
} from "@/infrastructure/crypto/secretEncryption";
import {
  createProject,
  deleteProject,
  setAdminCheck,
  updateProject,
} from "@/application/project/projectUseCases";
import {
  chatMessageSchema,
  costLimitsSchema,
  predictSchema,
  updateVersionSchema,
  versionNameSchema,
} from "@/app/api/projects/_lib/schemas";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/application/errors";

const OWNER = "owner@x.com";
const OTHER = "intruder@x.com";
import { projectRepository } from "@/infrastructure/db/repositories/projectRepository";

// --- Fake item store, injected in place of the real one --------------------

// The mock is hoisted above imports by vitest, so projectRepository (imported
// at the top) binds to this store. A file-level reference rather than the
// default in tests/setup.ts, because the cascade cases seed and inspect rows.
vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = (await import("@/infrastructure/db/store")) as unknown as FakeStore;
// What the fakes below raise is what the store raises, so the use cases'
// mapping is exercised against the real error names.
const { ConditionalWriteError, TransactionCancelledError } = store;

// --- Fixtures & fake ports --------------------------------------------------

function projectFixture(name: string, overrides: Partial<Project> = {}): Project {
  return {
    name,
    displayName: name,
    description: "",
    projectType: "llm",
    ownerEmail: "owner@x.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function versionFixture(
  projectName: string,
  versionName: string,
  overrides: Partial<Version> = {},
): Version {
  return {
    projectName,
    versionName,
    systemPrompt: "",
    userPromptTemplate: "",
    model: "openai/gpt-5-mini",
    parameters: { piiFiltering: false },
    mcpList: [],
    skillList: [],
    subagentList: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function versionInput(): VersionInput {
  return {
    systemPrompt: "",
    userPromptTemplate: "",
    model: "openai/gpt-5-mini",
    parameters: { piiFiltering: false },
    mcpList: [],
    skillList: [],
    subagentList: [],
  };
}

function makeProjectRepo(initial: Project[] = []): ProjectRepository {
  let projects = [...initial];
  return {
    async get(name) {
      return projects.find((p) => p.name === name) ?? null;
    },
    async list() {
      return projects;
    },
    async create(project) {
      projects = [...projects, project];
    },
    async update(project) {
      projects = projects.map((p) => (p.name === project.name ? project : p));
    },
    async publish(project) {
      projects = projects.map((p) => (p.name === project.name ? project : p));
    },
    async delete(name) {
      projects = projects.filter((p) => p.name !== name);
    },
    async getApiToken() {
      return null;
    },
    async setApiToken() {},
    async deleteApiToken() {},
  };
}

function makeVersionRepo(initial: Version[] = []): VersionRepository {
  let versions = [...initial];
  return {
    async get(projectName, versionName) {
      if (versionName === "published") {
        return null;
      }
      return (
        versions.find((v) => v.projectName === projectName && v.versionName === versionName) ?? null
      );
    },
    async list(projectName, limit, after) {
      return versions
        .filter((v) => v.projectName === projectName)
        .sort((a, b) => a.versionName.localeCompare(b.versionName))
        .filter((v) => !after || v.versionName > after)
        .slice(0, limit);
    },
    async create(version) {
      if (
        versions.some(
          (v) => v.projectName === version.projectName && v.versionName === version.versionName,
        )
      ) {
        throw new ConditionalWriteError("The conditional request failed");
      }
      versions = [...versions, version];
    },
    async put(version) {
      versions = [
        ...versions.filter(
          (v) => !(v.projectName === version.projectName && v.versionName === version.versionName),
        ),
        version,
      ];
    },
    async delete(projectName, versionName) {
      versions = versions.filter(
        (v) => !(v.projectName === projectName && v.versionName === versionName),
      );
    },
  };
}

/** Registry where every reference resolves — the default for tests that are
 * not about reference validation. Tests that are pass their own set. */
const ALL_REFS_EXIST: VersionRefRepos = {
  skills: { get: async (name) => ({ name }) as never },
  mcps: { get: async (name) => ({ name, url: `https://${name}.example/mcp` }) as never },
  externalAgents: { get: async (name) => ({ name }) as never },
  projects: { get: async (name) => ({ name }) as never },
};

/** Registry where nothing resolves. */
const NO_REFS_EXIST: VersionRefRepos = {
  skills: { get: async () => null },
  mcps: { get: async () => null },
  externalAgents: { get: async () => null },
  projects: { get: async () => null },
};

// Thin wrappers so the existing cases keep their signature; `refs` is required
// on the real use cases (a route that forgets it is a type error).
function createVersion(
  versions: VersionRepository,
  projects: ProjectRepository,
  projectName: string,
  input: CreateVersionInput,
  userEmail: string,
  refs: VersionRefRepos = ALL_REFS_EXIST,
): Promise<Version> {
  return createVersionUseCase(versions, projects, projectName, input, userEmail, refs, secretCipher);
}

/** The cipher is injected now; every test below still calls this as before. */
function toVersionView(version: Version): Version {
  return toVersionViewUseCase(secretCipher, version);
}

function updateVersion(
  versions: VersionRepository,
  projects: ProjectRepository,
  projectName: string,
  versionName: string,
  input: UpdateVersionInput,
  userEmail: string,
  refs: VersionRefRepos = ALL_REFS_EXIST,
): Promise<Version> {
  return updateVersionUseCase(
    versions,
    projects,
    projectName,
    versionName,
    input,
    userEmail,
    refs,
    secretCipher,
  );
}

// --- Tests ------------------------------------------------------------------

describe("listVersions", () => {
  it("reads every version through bounded repository pages", async () => {
    const stored = Array.from({ length: 102 }, (_, index) =>
      versionFixture("p", `v-${String(index).padStart(3, "0")}`),
    );
    const repo = makeVersionRepo(stored);
    const list = repo.list.bind(repo);
    const pageSizes: number[] = [];
    repo.list = async (projectName, limit, after) => {
      const page = await list(projectName, limit, after);
      pageSizes.push(page.length);
      return page;
    };

    await expect(listVersions(repo, "p")).resolves.toHaveLength(stored.length);
    expect(pageSizes).toEqual([100, 2]);
  });
});

describe("createVersion naming", () => {
  it("auto-assigns '1' for the first version", async () => {
    const created = await createVersion(
      makeVersionRepo(),
      makeProjectRepo([projectFixture("p")]),
      "p",
      versionInput(),
      OWNER,
    );
    expect(created.versionName).toBe("1");
  });

  it("auto-increments past the max numeric version, ignoring non-numeric names", async () => {
    const created = await createVersion(
      makeVersionRepo([
        versionFixture("p", "1"),
        versionFixture("p", "2"),
        versionFixture("p", "draft"),
      ]),
      makeProjectRepo([projectFixture("p")]),
      "p",
      versionInput(),
      OWNER,
    );
    expect(created.versionName).toBe("3");
  });

  it("honors an explicit versionName", async () => {
    const created = await createVersion(
      makeVersionRepo(),
      makeProjectRepo([projectFixture("p")]),
      "p",
      { ...versionInput(), versionName: "beta" },
      OWNER,
    );
    expect(created.versionName).toBe("beta");
  });

  it("rejects a duplicate explicit versionName with ConflictError", async () => {
    await expect(
      createVersion(
        makeVersionRepo([versionFixture("p", "1")]),
        makeProjectRepo([projectFixture("p")]),
        "p",
        { ...versionInput(), versionName: "1" },
        OWNER,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("maps a lost conditional-create race to ConflictError", async () => {
    const versions = makeVersionRepo();
    versions.create = async () => {
      throw new ConditionalWriteError("The conditional request failed");
    };

    await expect(
      createVersion(
        versions,
        makeProjectRepo([projectFixture("p")]),
        "p",
        versionInput(),
        OWNER,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects creation for a missing project with NotFoundError", async () => {
    await expect(
      createVersion(makeVersionRepo(), makeProjectRepo(), "nope", versionInput(), OWNER),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects creation by a non-owner with ForbiddenError", async () => {
    await expect(
      createVersion(
        makeVersionRepo(),
        makeProjectRepo([projectFixture("p")]),
        "p",
        versionInput(),
        OTHER,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("tool bindings on a project type that cannot run them", () => {
  // Only agent projects run the tool loop; every other type is dispatched to a
  // single-shot completion. A binding stored on one of those used to be
  // accepted, shown in the editor, and then silently ignored at run time.
  it("rejects an MCP server, skill or subagent added to a non-agent project", async () => {
    for (const input of [
      { mcpList: [{ name: "real-mcp" }] },
      { skillList: ["real-skill"] },
      { subagentList: [{ name: "real-project", type: "local" as const }] },
    ]) {
      await expect(
        createVersion(
          makeVersionRepo(),
          makeProjectRepo([projectFixture("p", { projectType: "llm" })]),
          "p",
          { ...versionInput(), ...input },
          OWNER,
        ),
      ).rejects.toThrow(/does not run tools/);
    }
  });

  it("still lets an existing binding be edited away", async () => {
    // A version stored before the rule must stay saveable, or the dead
    // configuration can never be removed.
    const existing = {
      ...versionFixture("p", "1"),
      mcpList: [{ name: "legacy-mcp" }],
      skillList: ["legacy-skill"],
    };
    const updated = await updateVersion(
      makeVersionRepo([existing]),
      makeProjectRepo([projectFixture("p", { projectType: "llm" })]),
      "p",
      "1",
      { mcpList: [{ name: "legacy-mcp" }], skillList: [] },
      OWNER,
    );

    expect(updated.skillList).toEqual([]);
    expect(updated.mcpList).toEqual([{ name: "legacy-mcp" }]);
  });

  it("accepts them on an agent project", async () => {
    const created = await createVersion(
      makeVersionRepo(),
      makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
      "p",
      { ...versionInput(), skillList: ["real-skill"] },
      OWNER,
    );

    expect(created.skillList).toEqual(["real-skill"]);
  });
});

describe("version reference validation", () => {
  it("rejects local and remote agents with the same model-visible name", async () => {
    await expect(
      createVersion(
        makeVersionRepo(),
        makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
        "p",
        {
          ...versionInput(),
          subagentList: [
            { name: "shared", type: "local" },
            { name: "shared", type: "remote" },
          ],
        },
        OWNER,
      ),
    ).rejects.toThrow(/must have unique names/);
  });

  it("rejects the same MCP server bound twice", async () => {
    // A duplicate opens the server's session twice, and the second row silently
    // overwrites the first everywhere the run keys by server name. The console
    // cannot produce one; the API can.
    await expect(
      createVersion(
        makeVersionRepo(),
        makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
        "p",
        { ...versionInput(), mcpList: [{ name: "github" }, { name: "github" }] },
        OWNER,
      ),
    ).rejects.toThrow(/"github" is bound more than once/);
  });

  it("rejects the same skill bound twice", async () => {
    await expect(
      createVersion(
        makeVersionRepo(),
        makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
        "p",
        { ...versionInput(), skillList: ["review", "review"] },
        OWNER,
      ),
    ).rejects.toThrow(/"review" is bound more than once/);
  });

  it("rejects a create that names an MCP server, skill, or subagent that does not exist", async () => {
    await expect(
      createVersion(
        makeVersionRepo(),
        makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
        "p",
        { ...versionInput(), mcpList: [{ name: "ghost-mcp" }] },
        OWNER,
        NO_REFS_EXIST,
      ),
    ).rejects.toThrow(/MCP server "ghost-mcp" does not exist/);

    await expect(
      createVersion(
        makeVersionRepo(),
        makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
        "p",
        { ...versionInput(), skillList: ["ghost-skill"] },
        OWNER,
        NO_REFS_EXIST,
      ),
    ).rejects.toThrow(/Skill "ghost-skill" does not exist/);

    await expect(
      createVersion(
        makeVersionRepo(),
        makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
        "p",
        { ...versionInput(), subagentList: [{ name: "ghost-agent", type: "remote" }] },
        OWNER,
        NO_REFS_EXIST,
      ),
    ).rejects.toThrow(/Agent "ghost-agent" does not exist/);
  });

  it("reports every dangling reference at once", async () => {
    await expect(
      createVersion(
        makeVersionRepo(),
        makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
        "p",
        { ...versionInput(), mcpList: [{ name: "m1" }], skillList: ["s1"] },
        OWNER,
        NO_REFS_EXIST,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("keeps a version editable when a reference it already had was deleted", async () => {
    // Deleting an MCP server must not strand every version that ever used it:
    // only newly added references are checked.
    const existing = { ...versionFixture("p", "1"), mcpList: [{ name: "deleted-mcp" }] };
    const updated = await updateVersion(
      makeVersionRepo([existing]),
      makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
      "p",
      "1",
      { systemPrompt: "edited" },
      OWNER,
      NO_REFS_EXIST,
    );
    expect(updated.systemPrompt).toBe("edited");
    expect(updated.mcpList).toEqual([{ name: "deleted-mcp" }]);
  });

  it("still rejects a reference newly added by an update", async () => {
    const existing = { ...versionFixture("p", "1"), mcpList: [{ name: "deleted-mcp" }] };
    await expect(
      updateVersion(
        makeVersionRepo([existing]),
        makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
        "p",
        "1",
        { mcpList: [{ name: "deleted-mcp" }, { name: "ghost-mcp" }] },
        OWNER,
        NO_REFS_EXIST,
      ),
    ).rejects.toThrow(/"ghost-mcp" does not exist/);
  });

  it("accepts references that resolve", async () => {
    const created = await createVersion(
      makeVersionRepo(),
      makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
      "p",
      {
        ...versionInput(),
        mcpList: [{ name: "real-mcp" }],
        skillList: ["real-skill"],
        subagentList: [{ name: "real-project", type: "local" }],
      },
      OWNER,
    );
    expect(created.mcpList).toEqual([{ name: "real-mcp" }]);
  });
});

describe("MCP binding header overrides", () => {
  const bindingWith = (headers: Record<string, string | null>) => [
    { name: "shared-mcp", headers },
  ];

  it("encrypts override values at rest and never stores plaintext", async () => {
    const created = await createVersion(
      makeVersionRepo(),
      makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
      "p",
      { ...versionInput(), mcpList: bindingWith({ Authorization: "Bearer project-secret" }) },
      OWNER,
    );

    const stored = created.mcpList[0]?.headers?.Authorization as string;
    expect(isEncrypted(stored)).toBe(true);
    expect(decryptSecret(stored)).toBe("Bearer project-secret");
  });

  it("masks override values on the API view but keeps removals visible", async () => {
    const created = await createVersion(
      makeVersionRepo(),
      makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
      "p",
      {
        ...versionInput(),
        mcpList: bindingWith({
          Authorization: "Bearer super-secret-token-value",
          "X-Shared": null,
        }),
      },
      OWNER,
    );

    const view = toVersionView(created);
    const headers = view.mcpList[0]?.headers ?? {};
    expect(isMasked(headers.Authorization as string)).toBe(true);
    expect(headers.Authorization).not.toContain("secret");
    // A removal is not a secret — it must stay legible so the editor can show it.
    expect(headers["X-Shared"]).toBeNull();
  });

  it("keeps the stored secret when the masked view is submitted back", async () => {
    const projects = makeProjectRepo([projectFixture("p", { projectType: "agent" })]);
    const versions = makeVersionRepo();
    const created = await createVersion(
      versions,
      projects,
      "p",
      {
        ...versionInput(),
        mcpList: bindingWith({ Authorization: "Bearer super-secret-token-value" }),
      },
      OWNER,
    );
    const maskedView = toVersionView(created);

    const updated = await updateVersion(versions, projects, "p", created.versionName, {
      mcpList: maskedView.mcpList,
    }, OWNER);

    expect(updated.mcpList[0]?.headers?.Authorization).toBe(
      created.mcpList[0]?.headers?.Authorization,
    );
  });

  it("drops preserved secrets when the registry endpoint moved", async () => {
    const projects = makeProjectRepo([projectFixture("p", { projectType: "agent" })]);
    const versions = makeVersionRepo();
    const created = await createVersion(
      versions,
      projects,
      "p",
      {
        ...versionInput(),
        mcpList: bindingWith({ Authorization: "Bearer old-endpoint-token" }),
      },
      OWNER,
    );
    const maskedView = toVersionView(created);
    expect(maskedView.mcpList[0]?.headerTarget).toBeUndefined();
    const movedRefs: VersionRefRepos = {
      ...ALL_REFS_EXIST,
      mcps: {
        get: async (name) => ({ name, url: `https://moved-${name}.example/mcp` }) as never,
      },
    };

    const updated = await updateVersion(
      versions,
      projects,
      "p",
      created.versionName,
      { mcpList: maskedView.mcpList },
      OWNER,
      movedRefs,
    );

    expect(updated.mcpList).toEqual([{ name: "shared-mcp" }]);
  });

  it("drops a masked value under a header with no stored counterpart", async () => {
    const created = await createVersion(
      makeVersionRepo(),
      makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
      "p",
      { ...versionInput(), mcpList: bindingWith({ "X-New": "******" }) },
      OWNER,
    );
    // A mask can only confirm an existing secret, never create one.
    expect(created.mcpList[0]).toEqual({ name: "shared-mcp" });
  });

  it("stores no headers field when a binding has no overrides", async () => {
    const created = await createVersion(
      makeVersionRepo(),
      makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
      "p",
      { ...versionInput(), mcpList: [{ name: "shared-mcp" }] },
      OWNER,
    );
    expect(created.mcpList).toEqual([{ name: "shared-mcp" }]);
  });

  it("refuses a non-owner editing another project's overrides", async () => {
    const projects = makeProjectRepo([projectFixture("p", { projectType: "agent" })]);
    const versions = makeVersionRepo([versionFixture("p", "1")]);

    await expect(
      updateVersion(versions, projects, "p", "1", {
        mcpList: bindingWith({ Authorization: "Bearer stolen" }),
      }, OTHER),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("imageModel validation", () => {
  it("createVersion rejects an imageModel without the imageGeneration capability", async () => {
    await expect(
      createVersion(
        makeVersionRepo(),
        makeProjectRepo([projectFixture("p")]),
        "p",
        {
          ...versionInput(),
          parameters: { piiFiltering: false, imageGeneration: true, imageModel: "openai/gpt-5-mini" },
        },
        OWNER,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("createVersion rejects an unknown imageModel", async () => {
    await expect(
      createVersion(
        makeVersionRepo(),
        makeProjectRepo([projectFixture("p")]),
        "p",
        {
          ...versionInput(),
          parameters: { piiFiltering: false, imageGeneration: true, imageModel: "nope/none" },
        },
        OWNER,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("createVersion accepts an image-capable imageModel", async () => {
    const created = await createVersion(
      makeVersionRepo(),
      makeProjectRepo([projectFixture("p")]),
      "p",
      {
        ...versionInput(),
        parameters: {
          piiFiltering: false,
          imageGeneration: true,
          imageModel: "openai/gpt-image-2",
        },
      },
      OWNER,
    );
    expect(created.parameters.imageModel).toBe("openai/gpt-image-2");
  });

  it("updateVersion rejects parameters carrying an invalid imageModel", async () => {
    await expect(
      updateVersion(
        makeVersionRepo([versionFixture("p", "1")]),
        makeProjectRepo([projectFixture("p")]),
        "p",
        "1",
        { parameters: { piiFiltering: false, imageGeneration: true, imageModel: "nope/none" } },
        OWNER,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("updateVersion without parameters succeeds even when the stored imageModel is stale", async () => {
    const stale = versionFixture("p", "1", {
      parameters: { piiFiltering: false, imageGeneration: true, imageModel: "removed/model" },
    });
    const updated = await updateVersion(
      makeVersionRepo([stale]),
      makeProjectRepo([projectFixture("p")]),
      "p",
      "1",
      { systemPrompt: "updated" },
      OWNER,
    );
    expect(updated.systemPrompt).toBe("updated");
    expect(updated.parameters.imageModel).toBe("removed/model");
  });

  it("clears nullable optional settings while omitted settings remain unchanged", async () => {
    const existing = versionFixture("p", "1", {
      fallbackModel: "openai/gpt-4o-mini",
      maxTurn: 20,
    });
    const updated = await updateVersion(
      makeVersionRepo([existing]),
      makeProjectRepo([projectFixture("p")]),
      "p",
      "1",
      { fallbackModel: null, maxTurn: null },
      OWNER,
    );

    expect(updated.fallbackModel).toBeUndefined();
    expect(updated.maxTurn).toBeUndefined();
  });
});

describe("publishVersion", () => {
  it("points the published pointer at an existing version", async () => {
    const updated = await publishVersion(
      makeProjectRepo([projectFixture("p")]),
      makeVersionRepo([versionFixture("p", "1")]),
      "p",
      "1",
      OWNER,
    );
    expect(updated.publishedVersion).toBe("1");
  });

  it("rejects publishing a missing version with NotFoundError (404)", async () => {
    await expect(
      publishVersion(
        makeProjectRepo([projectFixture("p")]),
        makeVersionRepo(),
        "p",
        "99",
        OWNER,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects publishing on a missing project with NotFoundError (404)", async () => {
    await expect(
      publishVersion(makeProjectRepo(), makeVersionRepo([versionFixture("p", "1")]), "nope", "1", OWNER),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects publishing by a non-owner with ForbiddenError (403)", async () => {
    await expect(
      publishVersion(
        makeProjectRepo([projectFixture("p")]),
        makeVersionRepo([versionFixture("p", "1")]),
        "p",
        "1",
        OTHER,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("maps a concurrent project change to ConflictError", async () => {
    const projects = makeProjectRepo([projectFixture("p")]);
    projects.publish = async () => {
      throw new TransactionCancelledError("transaction cancelled");
    };
    await expect(
      publishVersion(projects, makeVersionRepo([versionFixture("p", "1")]), "p", "1", OWNER),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("deleteProject", () => {
  it("rejects a missing project with NotFoundError (404)", async () => {
    await expect(deleteProject(makeProjectRepo(), "nope", OWNER)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("rejects deletion by a non-owner with ForbiddenError (403)", async () => {
    await expect(
      deleteProject(makeProjectRepo([projectFixture("p")]), "p", OTHER),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

/**
 * `assertProjectWritable` widened every project mutation at once, so each path
 * that leads to it needs to say which way it went. Without these, a later change
 * that re-narrows one path — or over-widens one that should have stayed with the
 * owner — breaks nothing in CI.
 */
describe("the admin override, per mutation path", () => {
  beforeEach(() => {
    admins.emails = [OTHER];
    // Every case here trips the override's audit line by design.
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("lets an admin delete a project they do not own", async () => {
    const repo = makeProjectRepo([projectFixture("p")]);
    await expect(deleteProject(repo, "p", OTHER)).resolves.toBeUndefined();
    expect(await repo.get("p")).toBeNull();
  });

  it("lets an admin publish a version of a project they do not own", async () => {
    const updated = await publishVersion(
      makeProjectRepo([projectFixture("p")]),
      makeVersionRepo([versionFixture("p", "1")]),
      "p",
      "1",
      OTHER,
    );
    expect(updated.publishedVersion).toBe("1");
  });

  it("lets an admin create, update and delete a version on a project they do not own", async () => {
    const projects = makeProjectRepo([projectFixture("p")]);
    const versions = makeVersionRepo();

    const created = await createVersion(versions, projects, "p", versionInput(), OTHER);
    expect(created.versionName).toBe("1");

    const updated = await updateVersion(
      versions,
      projects,
      "p",
      "1",
      { systemPrompt: "rewritten by admin" },
      OTHER,
    );
    expect(updated.systemPrompt).toBe("rewritten by admin");

    await deleteVersion(versions, projects, "p", "1", OTHER);
    expect(await versions.get("p", "1")).toBeNull();
  });

  it("denies the override when the admin list cannot be read, rather than failing the request", async () => {
    /*
     * The non-owner path now depends on a settings read. If losing that store
     * threw, an unauthorized caller would get a 500 where they have always got a
     * 403 — the authorization answer would become a function of the store's
     * availability. It has to fail closed and stay a ForbiddenError.
     */
    setAdminCheck(async () => {
      throw new Error("DynamoDB unavailable");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        updateProject(makeProjectRepo([projectFixture("p")]), "p", { displayName: "X" }, OTHER),
      ).rejects.toBeInstanceOf(ForbiddenError);
    } finally {
      setAdminCheck(adminListCheck);
    }
  });
});

describe("updateProject ownership", () => {
  it("lets the owner update", async () => {
    const updated = await updateProject(
      makeProjectRepo([projectFixture("p")]),
      "p",
      { displayName: "Renamed" },
      OWNER,
    );
    expect(updated.displayName).toBe("Renamed");
  });

  it("rejects a non-owner with ForbiddenError (403)", async () => {
    await expect(
      updateProject(makeProjectRepo([projectFixture("p")]), "p", { displayName: "X" }, OTHER),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lets a configured admin update a project they do not own", async () => {
    admins.emails = [OTHER];
    const updated = await updateProject(
      makeProjectRepo([projectFixture("p")]),
      "p",
      { displayName: "Renamed by admin" },
      OTHER,
    );
    expect(updated.displayName).toBe("Renamed by admin");
  });

  it("still rejects a non-owner while an unrelated admin is configured", async () => {
    admins.emails = ["someone-else@example.com"];
    await expect(
      updateProject(makeProjectRepo([projectFixture("p")]), "p", { displayName: "X" }, OTHER),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("maps a stale project snapshot to ConflictError", async () => {
    const repo = makeProjectRepo([projectFixture("p")]);
    repo.update = async () => {
      throw new ConditionalWriteError("conditional check failed");
    };
    await expect(
      updateProject(repo, "p", { displayName: "Renamed" }, OWNER),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("projectRepository.delete cascade", () => {
  const row = (PK: string, SK: string) => ({ PK, SK });
  const keysOf = () => store.all().map(({ PK, SK }) => ({ PK, SK }));

  it("removes child rows and leaves a name-reserving tombstone", async () => {
    store.rows.clear();
    store.seed([
      row("PROJECT#p", "META"),
      row("PROJECT#p", "VERSION#1"),
      row("PROJECT#p", "VERSION#2"),
      row("USAGE#p", "DATE#2026-01-01"),
      row("USAGE#p", "DATE#2026-01-02"),
      // An unrelated project must survive the cascade.
      row("PROJECT#other", "META"),
    ]);

    await projectRepository.delete("p");

    expect(keysOf()).toEqual([row("PROJECT#other", "META"), row("PROJECT#p", "META")]);
    expect(await projectRepository.get("p")).toBeNull();
    await expect(projectRepository.create(projectFixture("p"))).rejects.toThrow(
      expect.objectContaining({ name: store.CONDITIONAL_WRITE_FAILED }),
    );
  });

  it("leaves META marked, and present, when a child delete fails midway", async () => {
    // The cascade marks META `deletingAt` first and removes it last, so a
    // failure in between leaves a row that says a deletion is under way —
    // never a project that looks live with half its children gone, and never
    // one that vanished with children still attached to its name.
    store.rows.clear();
    store.seed([
      { ...row("PROJECT#p", "META"), GSI1PK: "TYPE#PROJECT", GSI1SK: "p" },
      row("PROJECT#p", "VERSION#1"),
    ]);
    vi.spyOn(store, "deletePartition").mockRejectedValueOnce(new Error("connection reset"));

    await expect(projectRepository.delete("p")).rejects.toThrow(/connection reset/);
    expect(keysOf()).toEqual([row("PROJECT#p", "META"), row("PROJECT#p", "VERSION#1")]);
    const marked = await store.getItem(row("PROJECT#p", "META"));
    expect(marked?.deletingAt).toEqual(expect.any(String));
    expect(marked).not.toHaveProperty("GSI1PK");
    expect(marked).not.toHaveProperty("GSI1SK");
    await expect(projectRepository.get("p")).resolves.toBeNull();
    await expect(projectRepository.list(100)).resolves.toEqual([]);
  });
});

describe("createProject race", () => {
  it("maps a lost conditional-put race to ConflictError (409)", async () => {
    const repo = makeProjectRepo();
    repo.create = async () => {
      throw new ConditionalWriteError("The conditional request failed");
    };
    await expect(
      createProject(repo, {
        name: "p",
        displayName: "P",
        description: "",
        projectType: "llm",
        ownerEmail: OWNER,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("updateVersion / deleteVersion boundaries", () => {
  it("updateVersion rejects a missing version with NotFoundError (404)", async () => {
    await expect(
      updateVersion(makeVersionRepo(), makeProjectRepo([projectFixture("p")]), "p", "99", {}, OWNER),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("updateVersion rejects a non-owner with ForbiddenError (403)", async () => {
    await expect(
      updateVersion(
        makeVersionRepo([versionFixture("p", "1")]),
        makeProjectRepo([projectFixture("p")]),
        "p",
        "1",
        {},
        OTHER,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("deleteVersion rejects a missing version with NotFoundError (404)", async () => {
    await expect(
      deleteVersion(makeVersionRepo(), makeProjectRepo([projectFixture("p")]), "p", "99", OWNER),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("deleteVersion rejects a non-owner with ForbiddenError (403)", async () => {
    await expect(
      deleteVersion(
        makeVersionRepo([versionFixture("p", "1")]),
        makeProjectRepo([projectFixture("p")]),
        "p",
        "1",
        OTHER,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("deleteVersion rejects the currently published version", async () => {
    await expect(
      deleteVersion(
        makeVersionRepo([versionFixture("p", "1")]),
        makeProjectRepo([projectFixture("p", { publishedVersion: "1" })]),
        "p",
        "1",
        OWNER,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('deleteVersion resolves the "published" sentinel before the guard and the delete key', async () => {
    // The repository resolves the sentinel on read; deleteVersion must reuse
    // that name, or the guard compares against the raw segment and the delete
    // targets the nonexistent VERSION#published key.
    const versions = makeVersionRepo([versionFixture("p", "1"), versionFixture("p", "2")]);
    const baseGet = versions.get;
    versions.get = async (projectName, versionName) =>
      baseGet(projectName, versionName === "published" ? "2" : versionName);
    const deletedNames: string[] = [];
    versions.delete = async (_projectName, versionName) => {
      deletedNames.push(versionName);
    };
    await expect(
      deleteVersion(
        versions,
        makeProjectRepo([projectFixture("p", { publishedVersion: "2" })]),
        "p",
        "published",
        OWNER,
      ),
    ).rejects.toThrow(/cannot be deleted/);
    expect(deletedNames).toEqual([]);
  });

  it("maps a publish race during deletion to ConflictError", async () => {
    const versions = makeVersionRepo([versionFixture("p", "1")]);
    versions.delete = async () => {
      throw new TransactionCancelledError("transaction cancelled");
    };
    await expect(
      deleteVersion(versions, makeProjectRepo([projectFixture("p")]), "p", "1", OWNER),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("model capability validation", () => {
  it("rejects a tools-incapable model on an agent project with ValidationError", async () => {
    await expect(
      createVersion(
        makeVersionRepo(),
        makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
        "p",
        { ...versionInput(), model: "xai/grok-imagine-image" },
        OWNER,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects structuredOutput on a model without the capability", async () => {
    await expect(
      createVersion(
        makeVersionRepo(),
        makeProjectRepo([projectFixture("p")]),
        "p",
        {
          ...versionInput(),
          model: "anthropic/claude-fable-5",
          parameters: { piiFiltering: false, structuredOutput: true },
        },
        OWNER,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects reasoningTrace on a model that produces none", async () => {
    // Nothing would be recorded, and the checkbox would say otherwise.
    await expect(
      createVersion(
        makeVersionRepo(),
        makeProjectRepo([projectFixture("p")]),
        "p",
        {
          ...versionInput(),
          model: "bedrock/qwen3-coder-next",
          parameters: { piiFiltering: false, reasoningTrace: true },
        },
        OWNER,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("accepts reasoningTrace on a model that does", async () => {
    const created = await createVersion(
      makeVersionRepo(),
      makeProjectRepo([projectFixture("p")]),
      "p",
      {
        ...versionInput(),
        model: "anthropic/claude-fable-5",
        parameters: { piiFiltering: false, reasoningTrace: true },
      },
      OWNER,
    );
    expect(created.parameters.reasoningTrace).toBe(true);
  });

  it("keeps custom (unknown) models on the warn-only path", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const created = await createVersion(
        makeVersionRepo(),
        makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
        "p",
        { ...versionInput(), model: "custom/next-gen" },
        OWNER,
      );
      expect(created.model).toBe("custom/next-gen");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("versionNameSchema", () => {
  it("accepts slug names", () => {
    expect(versionNameSchema.safeParse("v1-beta").success).toBe(true);
    expect(versionNameSchema.safeParse("2").success).toBe(true);
  });

  it("rejects non-slug names", () => {
    expect(versionNameSchema.safeParse("My Version").success).toBe(false);
    expect(versionNameSchema.safeParse("V1.0").success).toBe(false);
  });

  it("rejects the reserved published-pointer sentinel", () => {
    expect(versionNameSchema.safeParse("published").success).toBe(false);
  });
});

describe("costLimitsSchema notification destinations", () => {
  it("accepts one destination per enabled messaging platform", () => {
    const parsed = costLimitsSchema.safeParse({
      alertThresholdUsd: 10,
      alertDestinations: [
        { kind: "slack", channelId: " C1 " },
        { kind: "telegram", chatId: -1001, threadId: 7 },
        { kind: "teams", conversationId: " 19:one " },
      ],
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.alertDestinations).toEqual([
      { kind: "slack", channelId: "C1" },
      { kind: "telegram", chatId: -1001, threadId: 7 },
      { kind: "teams", conversationId: "19:one" },
    ]);
  });

  it("rejects duplicate platforms and an invalid Telegram chat id", () => {
    expect(
      costLimitsSchema.safeParse({
        alertDestinations: [
          { kind: "slack", channelId: "C1" },
          { kind: "slack", channelId: "C2" },
        ],
      }).success,
    ).toBe(false);
    expect(
      costLimitsSchema.safeParse({
        alertDestinations: [{ kind: "telegram", chatId: 0 }],
      }).success,
    ).toBe(false);
  });
});

describe("updateVersionSchema", () => {
  it("accepts null to clear optional version settings", () => {
    const parsed = updateVersionSchema.safeParse({ fallbackModel: null, maxTurn: null });

    expect(parsed.success).toBe(true);
  });

  it("still accepts the pre-override mcpList shape and normalizes it to bindings", () => {
    // Clients written before per-version header overrides send plain names.
    const parsed = updateVersionSchema.safeParse({ mcpList: ["alpha", "beta"] });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.mcpList).toEqual([{ name: "alpha" }, { name: "beta" }]);
  });

  it("accepts a binding with header overrides, including a null removal", () => {
    const parsed = updateVersionSchema.safeParse({
      mcpList: [{ name: "alpha", headers: { Authorization: "Bearer x", "X-Gone": null } }],
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.mcpList?.[0]?.headers).toEqual({
      Authorization: "Bearer x",
      "X-Gone": null,
    });
  });

  it("rejects a binding with no server name", () => {
    expect(updateVersionSchema.safeParse({ mcpList: [{ headers: {} }] }).success).toBe(false);
    expect(updateVersionSchema.safeParse({ mcpList: [""] }).success).toBe(false);
  });
});

describe("predictSchema source images", () => {
  const image = { b64: "aGk=", mimeType: "image/png" };

  it("accepts source images for an image-project run", () => {
    const parsed = predictSchema.safeParse({ prompt: "make it night", images: [image] });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.images).toEqual([image]);
  });

  it("applies the same caps as every other attachment surface", () => {
    expect(predictSchema.safeParse({ prompt: "x", images: Array(5).fill(image) }).success).toBe(
      false,
    );
    expect(
      predictSchema.safeParse({ prompt: "x", images: [{ ...image, mimeType: "image/tiff" }] })
        .success,
    ).toBe(false);
    expect(
      predictSchema.safeParse({ prompt: "x", images: [{ ...image, b64: "A".repeat(7_500_000) }] })
        .success,
    ).toBe(false);
  });
});

describe("chatMessageSchema content parts", () => {
  const imagePart = {
    type: "image_url",
    image_url: { url: "data:image/png;base64,aGk=", detail: "high" },
  };

  it("still accepts a plain string body", () => {
    expect(chatMessageSchema.safeParse({ role: "user", content: "hello" }).success).toBe(true);
    expect(chatMessageSchema.safeParse({ role: "assistant", content: null }).success).toBe(true);
  });

  it("accepts mixed text and image parts", () => {
    const parsed = chatMessageSchema.safeParse({
      role: "user",
      content: [{ type: "text", text: "what is this?" }, imagePart],
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.content).toEqual([{ type: "text", text: "what is this?" }, imagePart]);
  });

  it("accepts an https image url", () => {
    const parsed = chatMessageSchema.safeParse({
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects image urls with any other scheme", () => {
    for (const url of ["file:///etc/passwd", "http://example.com/a.png", "data:text/html,x"]) {
      const parsed = chatMessageSchema.safeParse({
        role: "user",
        content: [{ type: "image_url", image_url: { url } }],
      });
      expect(parsed.success, url).toBe(false);
    }
  });

  it("rejects an image payload over the size cap", () => {
    const parsed = chatMessageSchema.safeParse({
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(11_000_000)}` } },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown part type", () => {
    const parsed = chatMessageSchema.safeParse({
      role: "user",
      content: [{ type: "audio_url", audio_url: { url: "https://example.com/a.mp3" } }],
    });

    expect(parsed.success).toBe(false);
  });
});

/**
 * A binding's tool narrowing, from the API in to the API out.
 *
 * Three separate places rebuilt an McpBinding field by field — the write path,
 * the response view, and the repository read — and each of them dropped `tools`
 * on its own. Fixing one changed nothing observable, because the next one
 * dropped it again. So this covers the round trip rather than any single hop:
 * that is the only shape of test that would have failed.
 */
describe("a version's MCP tool narrowing survives a round trip", () => {
  const TOOLS = ["search", "fetch"];

  it("is stored by create and comes back on the view", async () => {
    const versions = makeVersionRepo();
    const projects = makeProjectRepo([projectFixture("p", { projectType: "agent" })]);

    const created = await createVersion(
      versions,
      projects,
      "p",
      { ...versionInput(), mcpList: [{ name: "real-mcp", tools: TOOLS }] },
      "owner@x.com",
    );

    expect(created.mcpList).toEqual([{ name: "real-mcp", tools: TOOLS }]);
    expect(toVersionView(created).mcpList).toEqual([{ name: "real-mcp", tools: TOOLS }]);
  });

  it("is kept by update", async () => {
    const versions = makeVersionRepo();
    const projects = makeProjectRepo([projectFixture("p", { projectType: "agent" })]);
    await createVersion(
      versions,
      projects,
      "p",
      { ...versionInput(), versionName: "1", mcpList: [{ name: "real-mcp" }] },
      "owner@x.com",
    );

    const updated = await updateVersion(
      versions,
      projects,
      "p",
      "1",
      { mcpList: [{ name: "real-mcp", tools: TOOLS }] },
      "owner@x.com",
    );

    expect(updated.mcpList).toEqual([{ name: "real-mcp", tools: TOOLS }]);
  });

  it("survives alongside a header override, and masking does not eat it", async () => {
    const versions = makeVersionRepo();
    const projects = makeProjectRepo([projectFixture("p", { projectType: "agent" })]);

    const created = await createVersion(
      versions,
      projects,
      "p",
      {
        ...versionInput(),
        mcpList: [{ name: "real-mcp", tools: TOOLS, headers: { Authorization: "Bearer secret" } }],
      },
      "owner@x.com",
    );

    expect(created.mcpList[0]?.tools).toEqual(TOOLS);
    // The view masks the header; the narrowing beside it is not a secret and
    // must be reported as it is.
    expect(toVersionView(created).mcpList[0]?.tools).toEqual(TOOLS);
  });
});
