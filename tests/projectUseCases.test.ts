// MCP header overrides are encrypted at rest, so the key must be present before
// the encryption module reads config.
process.env.AES_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Project mutation is "owner or admin", so these cases have to be able to say
 * which. Default: no admin configured, which is what every ownership case below
 * assumes and what a deployment that never set ADMIN_EMAILS has.
 */
const { admins } = vi.hoisted(() => ({ admins: { emails: [] as string[] } }));
vi.mock("@/lib/runtime-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runtime-settings")>()),
  isConfiguredAdmin: async (email: string) => admins.emails.includes(email.toLowerCase()),
}));
beforeEach(() => {
  admins.emails = [];
});
import type { Project, Version } from "@/domain/project/types";
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
import { createProject, deleteProject, updateProject } from "@/application/project/projectUseCases";
import {
  chatMessageSchema,
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

// --- Fake single-table store, injected in place of the real DynamoDB client ---

type ItemKey = { PK: string; SK: string };

const { store, fakeClient, batchFailuresRemaining } = vi.hoisted(() => {
  const store = new Map<string, ItemKey[]>();
  const batchFailuresRemaining = { value: 0 };
  const fakeClient = {
    async send(command: { input: Record<string, unknown> }) {
      const input = command.input;
      const requestItems = input.RequestItems as
        | Record<string, Array<{ DeleteRequest?: { Key: ItemKey } }>>
        | undefined;
      if (requestItems) {
        if (batchFailuresRemaining.value > 0) {
          batchFailuresRemaining.value -= 1;
          return { UnprocessedItems: requestItems };
        }
        for (const requests of Object.values(requestItems)) {
          for (const request of requests) {
            const key = request.DeleteRequest?.Key;
            if (!key) {
              continue;
            }
            const partition = store.get(key.PK);
            if (partition) {
              const next = partition.filter((k) => k.SK !== key.SK);
              if (next.length === 0) {
                store.delete(key.PK);
              } else {
                store.set(key.PK, next);
              }
            }
          }
        }
        return { UnprocessedItems: {} };
      }
      if (input.KeyConditionExpression) {
        const values = input.ExpressionAttributeValues as Record<string, string>;
        const pk = values[":pk"] ?? "";
        return { Items: [...(store.get(pk) ?? [])], LastEvaluatedKey: undefined };
      }
      if (input.UpdateExpression) {
        return {};
      }
      if (input.Key) {
        const key = input.Key as ItemKey;
        const partition = store.get(key.PK);
        if (partition) {
          const next = partition.filter((item) => item.SK !== key.SK);
          if (next.length === 0) {
            store.delete(key.PK);
          } else {
            store.set(key.PK, next);
          }
        }
        return {};
      }
      return {};
    },
  };
  return { store, fakeClient, batchFailuresRemaining };
});

// The mock is hoisted above imports by vitest, so projectRepository (imported
// at the top) binds to this fake client.
vi.mock("@/infrastructure/db/client", () => ({
  getDocumentClient: () => fakeClient,
  getTableName: () => "test-table",
}));

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
    async list(projectName) {
      return versions.filter((v) => v.projectName === projectName);
    },
    async create(version) {
      if (
        versions.some(
          (v) => v.projectName === version.projectName && v.versionName === version.versionName,
        )
      ) {
        const error = new Error("The conditional request failed");
        error.name = "ConditionalCheckFailedException";
        throw error;
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
  mcps: { get: async (name) => ({ name }) as never },
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
      const error = new Error("The conditional request failed");
      error.name = "ConditionalCheckFailedException";
      throw error;
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
      const error = new Error("transaction cancelled");
      error.name = "TransactionCanceledException";
      throw error;
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
      const error = new Error("conditional check failed");
      error.name = "ConditionalCheckFailedException";
      throw error;
    };
    await expect(
      updateProject(repo, "p", { displayName: "Renamed" }, OWNER),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("projectRepository.delete cascade", () => {
  it("removes the project META, all its versions, and its usage rows", async () => {
    store.clear();
    store.set("PROJECT#p", [
      { PK: "PROJECT#p", SK: "META" },
      { PK: "PROJECT#p", SK: "VERSION#1" },
      { PK: "PROJECT#p", SK: "VERSION#2" },
    ]);
    store.set("USAGE#p", [
      { PK: "USAGE#p", SK: "DATE#2026-01-01" },
      { PK: "USAGE#p", SK: "DATE#2026-01-02" },
    ]);
    // An unrelated project must survive the cascade.
    store.set("PROJECT#other", [{ PK: "PROJECT#other", SK: "META" }]);

    await projectRepository.delete("p");

    expect(store.has("PROJECT#p")).toBe(false);
    expect(store.has("USAGE#p")).toBe(false);
    expect(store.get("PROJECT#other")).toHaveLength(1);
  });

  it("fails without deleting META when DynamoDB keeps returning unprocessed children", async () => {
    store.clear();
    store.set("PROJECT#p", [
      { PK: "PROJECT#p", SK: "META" },
      { PK: "PROJECT#p", SK: "VERSION#1" },
    ]);
    batchFailuresRemaining.value = 5;

    await expect(projectRepository.delete("p")).rejects.toThrow(/Failed to delete all/);
    expect(store.get("PROJECT#p")).toContainEqual({ PK: "PROJECT#p", SK: "META" });
  });
});

describe("createProject race", () => {
  it("maps a lost conditional-put race to ConflictError (409)", async () => {
    const repo = makeProjectRepo();
    repo.create = async () => {
      const error = new Error("The conditional request failed");
      error.name = "ConditionalCheckFailedException";
      throw error;
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

  it("maps a publish race during deletion to ConflictError", async () => {
    const versions = makeVersionRepo([versionFixture("p", "1")]);
    versions.delete = async () => {
      const error = new Error("transaction cancelled");
      error.name = "TransactionCanceledException";
      throw error;
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
