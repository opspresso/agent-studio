import { describe, expect, it, vi } from "vitest";
import type { Project, Version } from "@/domain/project/types";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { VersionInput } from "@/application/project/versionUseCases";
import {
  createVersion,
  deleteVersion,
  publishVersion,
  updateVersion,
} from "@/application/project/versionUseCases";
import { createProject, deleteProject, updateProject } from "@/application/project/projectUseCases";
import { versionNameSchema } from "@/app/api/projects/_lib/schemas";
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

const { store, fakeClient } = vi.hoisted(() => {
  const store = new Map<string, ItemKey[]>();
  const fakeClient = {
    async send(command: { input: Record<string, unknown> }) {
      const input = command.input;
      const requestItems = input.RequestItems as
        | Record<string, Array<{ DeleteRequest?: { Key: ItemKey } }>>
        | undefined;
      if (requestItems) {
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
      return {};
    },
  };
  return { store, fakeClient };
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
    async delete(name) {
      projects = projects.filter((p) => p.name !== name);
    },
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
