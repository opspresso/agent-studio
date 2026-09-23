process.env.AES_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, AgentConfiguration } from "@/domain/project/types";
import type { ProjectRepository } from "@/domain/project/repository";
import type { FakeStore } from "./fakeStore";
import type { AgentConfigurationInput } from "@/application/project/configurationUseCases";
import type { ConfigurationRefRepos } from "@/application/project/configurationPolicy";
import { putAgentConfiguration, toAgentConfigurationView } from "@/application/project/configurationUseCases";
import { resolveMcpBindings } from "@/application/project/mcpBindingSettings";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { isEncrypted, isMasked, mergeOutboundHeaders } from "@/infrastructure/crypto/secretEncryption";
import { agentMcpHeadersContext } from "@/domain/security/secretContext";
import { createProject, deleteProject, setAdminCheck, updateProject } from "@/application/project/projectUseCases";
import { chatMessageSchema, costLimitsSchema, putAgentConfigurationSchema, agentParametersSchema } from "@/app/api/projects/_lib/schemas";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/application/errors";
import { projectRepository } from "@/infrastructure/db/repositories/projectRepository";

vi.mock("@/infrastructure/db/store", async () => (await import("./fakeStore")).createFakeStore());
const store = await import("@/infrastructure/db/store") as unknown as FakeStore;
const { ConditionalWriteError } = store;
const OWNER = "owner@x.com";
const OTHER = "intruder@x.com";
const admins = { emails: [] as string[] };
const adminListCheck = async (email: string) => admins.emails.includes(email.toLowerCase());
setAdminCheck(adminListCheck);
beforeEach(() => { admins.emails = []; });

function projectFixture(name: string, overrides: Partial<Project> = {}): Project {
  return { name, displayName: name, description: "", projectType: "agent", ownerEmail: OWNER,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...overrides };
}
function configurationInput(): AgentConfigurationInput {
  return { systemPrompt: "", model: "openai/gpt-5-mini", parameters: { piiFiltering: false },
    mcpList: [], skillList: [], subagentList: [] };
}
function configurationFixture(projectName: string, overrides: Partial<AgentConfiguration> = {}): AgentConfiguration {
  return { ...configurationInput(), projectName, ...overrides };
}
function makeProjectRepo(initial: Project[] = []): ProjectRepository {
  let projects = [...initial];
  return {
    get: async name => projects.find(p => p.name === name) ?? null,
    list: async () => projects,
    create: async project => { projects = [...projects, project]; },
    update: async project => { projects = projects.map(p => p.name === project.name ? project : p); },
    delete: async name => { projects = projects.filter(p => p.name !== name); },
    getApiToken: async () => null, setApiToken: async () => {}, deleteApiToken: async () => {},
  };
}
/** Settings shared by the isolated project-repository fixtures in a scenario. */
type SettingsFixture = Map<string, AgentConfiguration>;
const settingsFixture = (initial: AgentConfiguration[] = []): SettingsFixture => new Map(initial.map(c => [c.projectName, c]));
const ALL_REFS_EXIST: ConfigurationRefRepos = {
  skills: { get: async name => ({ name }) as never },
  mcps: { get: async name => ({ name, url: `https://${name}.example/mcp` }) as never },
  externalAgents: { get: async name => ({ name }) as never },
  projects: { get: async name => ({ name }) as never },
};
const NO_REFS_EXIST: ConfigurationRefRepos = {
  skills: { get: async () => null }, mcps: { get: async () => null },
  externalAgents: { get: async () => null }, projects: { get: async () => null },
};

async function writeSettings(settings: SettingsFixture, projects: ProjectRepository, name: string,
  input: AgentConfigurationInput, email: string, refs = ALL_REFS_EXIST): Promise<AgentConfiguration> {
  const repository: ProjectRepository = { ...projects,
    async get(name, options) {
      const project = await projects.get(name, options);
      return project ? { ...project, configuration: settings.get(name) ?? project.configuration } : null;
    },
    async update(project, expected) {
      await projects.update(project, expected);
      if (project.configuration) settings.set(project.name, project.configuration);
    },
  };
  await putAgentConfiguration({ projects: repository, refs, cipher: secretCipher }, name,
    { ...input, expectedUpdatedAt: (await projects.get(name))?.updatedAt ?? "missing" }, email);
  return settings.get(name)!;
}
function settingsView(configuration: AgentConfiguration): AgentConfiguration {
  return toAgentConfigurationView(secretCipher, { ...projectFixture(configuration.projectName), configuration }).configuration!;
}
type ConfigurationPatch = Partial<Omit<AgentConfigurationInput, "fallbackModel" | "maxTurn">> & { fallbackModel?: string | null; maxTurn?: number | null };
/** Build a full replacement from the scenario's editable draft. The use case receives no patch. */
function patchSettings(settings: SettingsFixture, projects: ProjectRepository, name: string,
  patch: ConfigurationPatch, email: string, refs = ALL_REFS_EXIST) {
  const existing = settings.get(name)!;
  return writeSettings(settings, projects, name, { ...settingsView(existing), ...patch,
    fallbackModel: patch.fallbackModel === null ? undefined : patch.fallbackModel ?? existing.fallbackModel,
    maxTurn: patch.maxTurn === null ? undefined : patch.maxTurn ?? existing.maxTurn,
  }, email, refs);
}
function previewBindings(settings: SettingsFixture, mcps: ConfigurationRefRepos["mcps"], cipher: typeof secretCipher,
  name: string, bindings: AgentConfiguration["mcpList"]) {
  return resolveMcpBindings(cipher, mcps, bindings, settings.get(name)?.mcpList ?? [], server => agentMcpHeadersContext(name, server));
}
const configurationSchema = { safeParse: (fields: object) => putAgentConfigurationSchema.safeParse({
  ...configurationInput(), expectedUpdatedAt: "2026-01-01T00:00:00.000Z", ...fields,
}) };

describe("model type validation", () => {
  const embedding = "openrouter/text-embedding-3-small";

  it("rejects an embedding model as the primary model", async () => {
    await expect(
      writeSettings(
        settingsFixture(),
        makeProjectRepo([projectFixture("p")]),
        "p",
        { ...configurationInput(), model: embedding },
        OWNER,
      ),
    ).rejects.toThrow(/Model type does not support agent projects/);
  });

  it("rejects an embedding model as the fallback model", async () => {
    await expect(
      writeSettings(
        settingsFixture(),
        makeProjectRepo([projectFixture("p")]),
        "p",
        { ...configurationInput(), fallbackModel: embedding },
        OWNER,
      ),
    ).rejects.toThrow(/Model type does not support agent projects/);
  });

  it("reports a text model without tools as an agent capability mismatch", async () => {
    await expect(
      writeSettings(
        settingsFixture(),
        makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
        "p",
        { ...configurationInput(), model: "openai/o1-pro" },
        OWNER,
      ),
    ).rejects.toThrow(/does not support tool calling required by agent projects/);
  });
});

describe("configuration reference validation", () => {
  it("rejects local and remote agents with the same model-visible name", async () => {
    await expect(
      writeSettings(
        settingsFixture(),
        makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
        "p",
        {
          ...configurationInput(),
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
      writeSettings(
        settingsFixture(),
        makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
        "p",
        { ...configurationInput(), mcpList: [{ name: "github" }, { name: "github" }] },
        OWNER,
      ),
    ).rejects.toThrow(/"github" is bound more than once/);
  });

  it("rejects the same skill bound twice", async () => {
    await expect(
      writeSettings(
        settingsFixture(),
        makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
        "p",
        { ...configurationInput(), skillList: ["review", "review"] },
        OWNER,
      ),
    ).rejects.toThrow(/"review" is bound more than once/);
  });

  it("rejects a create that names an MCP server, skill, or subagent that does not exist", async () => {
    await expect(
      writeSettings(
        settingsFixture(),
        makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
        "p",
        { ...configurationInput(), mcpList: [{ name: "ghost-mcp" }] },
        OWNER,
        NO_REFS_EXIST,
      ),
    ).rejects.toThrow(/MCP server "ghost-mcp" does not exist/);

    await expect(
      writeSettings(
        settingsFixture(),
        makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
        "p",
        { ...configurationInput(), skillList: ["ghost-skill"] },
        OWNER,
        NO_REFS_EXIST,
      ),
    ).rejects.toThrow(/Skill "ghost-skill" does not exist/);

    await expect(
      writeSettings(
        settingsFixture(),
        makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
        "p",
        { ...configurationInput(), subagentList: [{ name: "ghost-agent", type: "remote" }] },
        OWNER,
        NO_REFS_EXIST,
      ),
    ).rejects.toThrow(/Agent "ghost-agent" does not exist/);
  });

  it("reports every dangling reference at once", async () => {
    await expect(
      writeSettings(
        settingsFixture(),
        makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
        "p",
        { ...configurationInput(), mcpList: [{ name: "m1" }], skillList: ["s1"] },
        OWNER,
        NO_REFS_EXIST,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("keeps a version editable when a reference it already had was deleted", async () => {
    // Deleting an MCP server must not strand every version that ever used it:
    // only newly added references are checked.
    const existing = { ...configurationFixture("p"), mcpList: [{ name: "deleted-mcp" }] };
    const updated = await patchSettings(
      settingsFixture([existing]),
      makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
      "p",
      { systemPrompt: "edited" },
      OWNER,
      NO_REFS_EXIST,
    );
    expect(updated.systemPrompt).toBe("edited");
    expect(updated.mcpList).toEqual([{ name: "deleted-mcp" }]);
  });

  it("still rejects a reference newly added by an update", async () => {
    const existing = { ...configurationFixture("p"), mcpList: [{ name: "deleted-mcp" }] };
    await expect(
      patchSettings(
        settingsFixture([existing]),
        makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
        "p",
        { mcpList: [{ name: "deleted-mcp" }, { name: "ghost-mcp" }] },
        OWNER,
        NO_REFS_EXIST,
      ),
    ).rejects.toThrow(/"ghost-mcp" does not exist/);
  });

  it("accepts references that resolve", async () => {
    const created = await writeSettings(
      settingsFixture(),
      makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
      "p",
      {
        ...configurationInput(),
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

  it("preserves endpoint headers when updating only a model and tool selection, and clears them explicitly", async () => {
    const projects = makeProjectRepo([projectFixture("p", { projectType: "agent" })]);
    const settings = settingsFixture();
    const created = await writeSettings(settings, projects, "p", {
      ...configurationInput(), mcpList: bindingWith({ "X-MCP-Toolsets": "repos,actions" }),
    }, OWNER);
    const updated = await patchSettings(settings, projects, "p", {
      model: "openai/gpt-5-mini", mcpList: [{ name: "shared-mcp", tools: ["actions_get"] }],
    }, OWNER);
    expect(updated.mcpList[0]?.headers).toEqual(created.mcpList[0]?.headers);
    expect(updated.mcpList[0]?.tools).toEqual(["actions_get"]);
    expect(mergeOutboundHeaders({}, updated.mcpList[0]!.headers!, undefined,
      agentMcpHeadersContext("p", "shared-mcp"))["X-MCP-Toolsets"]).toBe("repos,actions");
    const cleared = await patchSettings(settings, projects, "p", {
      mcpList: [{ name: "shared-mcp", tools: ["actions_get"], headers: {} }],
    }, OWNER);
    expect(cleared.mcpList[0]?.headers).toBeUndefined();
    expect(cleared.mcpList[0]?.headerTarget).toBeUndefined();
  });

  it("encrypts override values at rest and never stores plaintext", async () => {
    const created = await writeSettings(
      settingsFixture(),
      makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
      "p",
      { ...configurationInput(), mcpList: bindingWith({ Authorization: "Bearer project-secret" }) },
      OWNER,
    );

    const stored = created.mcpList[0]?.headers?.Authorization as string;
    expect(isEncrypted(stored)).toBe(true);
    expect(
      mergeOutboundHeaders(
        {},
        { Authorization: stored },
        undefined,
        agentMcpHeadersContext("p", "shared-mcp"),
      ).Authorization,
    ).toBe("Bearer project-secret");
  });

  it("masks override values on the API view but keeps removals visible", async () => {
    const created = await writeSettings(
      settingsFixture(),
      makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
      "p",
      {
        ...configurationInput(),
        mcpList: bindingWith({
          Authorization: "Bearer super-secret-token-value",
          "X-Shared": null,
        }),
      },
      OWNER,
    );

    const view = settingsView(created);
    const headers = view.mcpList[0]?.headers ?? {};
    expect(isMasked(headers.Authorization as string)).toBe(true);
    expect(headers.Authorization).not.toContain("secret");
    // A removal is not a secret — it must stay legible so the editor can show it.
    expect(headers["X-Shared"]).toBeNull();
  });

  it("keeps the stored secret when the masked view is submitted back", async () => {
    const projects = makeProjectRepo([projectFixture("p", { projectType: "agent" })]);
    const settings = settingsFixture();
    const created = await writeSettings(
      settings,
      projects,
      "p",
      {
        ...configurationInput(),
        mcpList: bindingWith({ Authorization: "Bearer super-secret-token-value" }),
      },
      OWNER,
    );
    const maskedView = settingsView(created);

    const updated = await patchSettings(settings, projects, "p", {
      mcpList: maskedView.mcpList,
    }, OWNER);

    expect(updated.mcpList[0]?.headers?.Authorization).toBe(
      created.mcpList[0]?.headers?.Authorization,
    );
  });

  it("keeps the stable Agent credential context for preview", async () => {
    const projects = makeProjectRepo([projectFixture("p", { projectType: "agent" })]);
    const settings = settingsFixture();
    const created = await writeSettings(
      settings,
      projects,
      "p",
      {
        ...configurationInput(),
        mcpList: bindingWith({ Authorization: "Bearer preview-secret" }),
      },
      OWNER,
    );

    const draft = await previewBindings(
      settings,
      ALL_REFS_EXIST.mcps,
      secretCipher,
      "p",
      settingsView(created).mcpList,
    );
    const rebound = draft[0]?.headers?.Authorization as string;
    expect(rebound).toBe(created.mcpList[0]?.headers?.Authorization);
    expect(
      mergeOutboundHeaders(
        {},
        { Authorization: rebound },
        undefined,
        agentMcpHeadersContext("p", "shared-mcp"),
      ).Authorization,
    ).toBe("Bearer preview-secret");
  });



  it("drops preserved secrets when the registry endpoint moved", async () => {
    const projects = makeProjectRepo([projectFixture("p", { projectType: "agent" })]);
    const settings = settingsFixture();
    const created = await writeSettings(
      settings,
      projects,
      "p",
      {
        ...configurationInput(),
        mcpList: bindingWith({ Authorization: "Bearer old-endpoint-token" }),
      },
      OWNER,
    );
    const maskedView = settingsView(created);
    expect(maskedView.mcpList[0]?.headerTarget).toBeUndefined();
    const movedRefs: ConfigurationRefRepos = {
      ...ALL_REFS_EXIST,
      mcps: {
        get: async (name) => ({ name, url: `https://moved-${name}.example/mcp` }) as never,
      },
    };

    const updated = await patchSettings(
      settings,
      projects,
      "p",
      { mcpList: maskedView.mcpList },
      OWNER,
      movedRefs,
    );

    expect(updated.mcpList).toEqual([{ name: "shared-mcp" }]);
  });

  it("drops a masked value under a header with no stored counterpart", async () => {
    const created = await writeSettings(
      settingsFixture(),
      makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
      "p",
      { ...configurationInput(), mcpList: bindingWith({ "X-New": "******" }) },
      OWNER,
    );
    // A mask can only confirm an existing secret, never create one.
    expect(created.mcpList[0]).toEqual({ name: "shared-mcp" });
  });

  it("stores no headers field when a binding has no overrides", async () => {
    const created = await writeSettings(
      settingsFixture(),
      makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
      "p",
      { ...configurationInput(), mcpList: [{ name: "shared-mcp" }] },
      OWNER,
    );
    expect(created.mcpList).toEqual([{ name: "shared-mcp" }]);
  });

  it("refuses a non-owner editing another project's overrides", async () => {
    const projects = makeProjectRepo([projectFixture("p", { projectType: "agent" })]);
    const settings = settingsFixture([configurationFixture("p")]);

    await expect(
      patchSettings(settings, projects, "p", {
        mcpList: bindingWith({ Authorization: "Bearer stolen" }),
      }, OTHER),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("imageModel validation", () => {
  it("rejects an imageModel without the imageGeneration capability", async () => {
    await expect(
      writeSettings(
        settingsFixture(),
        makeProjectRepo([projectFixture("p")]),
        "p",
        {
          ...configurationInput(),
          parameters: { piiFiltering: false, imageGeneration: true, imageModel: "openai/gpt-5-mini" },
        },
        OWNER,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects an unknown imageModel", async () => {
    await expect(
      writeSettings(
        settingsFixture(),
        makeProjectRepo([projectFixture("p")]),
        "p",
        {
          ...configurationInput(),
          parameters: { piiFiltering: false, imageGeneration: true, imageModel: "nope/none" },
        },
        OWNER,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("accepts an image-capable imageModel", async () => {
    const created = await writeSettings(
      settingsFixture(),
      makeProjectRepo([projectFixture("p")]),
      "p",
      {
        ...configurationInput(),
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

  it("rejects an invalid imageModel in a configuration update", async () => {
    await expect(
      patchSettings(
        settingsFixture([configurationFixture("p")]),
        makeProjectRepo([projectFixture("p")]),
        "p",
        { parameters: { piiFiltering: false, imageGeneration: true, imageModel: "nope/none" } },
        OWNER,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });



  it("clears nullable optional settings while omitted settings remain unchanged", async () => {
    const existing = configurationFixture("p", {
      fallbackModel: "openai/gpt-4o-mini",
      maxTurn: 20,
    });
    const updated = await patchSettings(
      settingsFixture([existing]),
      makeProjectRepo([projectFixture("p")]),
      "p",
      { fallbackModel: null, maxTurn: null },
      OWNER,
    );

    expect(updated.fallbackModel).toBeUndefined();
    expect(updated.maxTurn).toBeUndefined();
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

describe("projectRepository.list paging", () => {
  it("fills a page rather than letting a dropped row end the walk", async () => {
    // `listProjects` stops on a short page, so a page filtered down to fewer
    // rows than were asked for reads as the end of the catalogue — and every
    // project after it disappears from the console and repair sweep at once.
    store.rows.clear();
    const live = (name: string) => ({
      PK: `PROJECT#${name}`,
      SK: "META",
      GSI1PK: "TYPE#PROJECT",
      GSI1SK: name,
      entityType: "PROJECT",
      ...projectFixture(name),
    });
    store.seed([
      live("a"),
      // A row the index still reaches but the filter refuses.
      { ...live("b"), deletingAt: "2026-01-01T00:00:00.000Z" },
      live("c"),
    ]);

    await expect(projectRepository.list(2)).resolves.toMatchObject([
      { name: "a" },
      { name: "c" },
    ]);
  });
});

describe("projectRepository.delete cascade", () => {
  const row = (PK: string, SK: string) => ({ PK, SK });
  const keysOf = () => store.all().map(({ PK, SK }) => ({ PK, SK }));

  it("removes child rows and leaves a name-reserving tombstone", async () => {
    store.rows.clear();
    store.seed([
      row("PROJECT#p", "META"),
      row("PROJECT#p", "APITOKEN"),
      row("PROJECT#p", "WORKSPACEPOLICY"),
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
      row("PROJECT#p", "APITOKEN"),
    ]);
    vi.spyOn(store, "deletePartition").mockRejectedValueOnce(new Error("connection reset"));

    await expect(projectRepository.delete("p")).rejects.toThrow(/connection reset/);
    expect(keysOf()).toEqual([row("PROJECT#p", "APITOKEN"), row("PROJECT#p", "META")]);
    const marked = await store.getItem(row("PROJECT#p", "META"));
    expect(marked?.deletingAt).toEqual(expect.any(String));
    expect(marked).not.toHaveProperty("GSI1PK");
    expect(marked).not.toHaveProperty("GSI1SK");
    await expect(projectRepository.get("p")).resolves.toBeNull();
    await expect(projectRepository.list(100)).resolves.toEqual([]);
  });

  it("lets the owner resume a cascade left marked by a partial failure", async () => {
    store.rows.clear();
    const project = projectFixture("recover-delete");
    store.seed([
      {
        ...row("PROJECT#recover-delete", "META"),
        ...project,
        entityType: "PROJECT",
        GSI1PK: "TYPE#PROJECT",
        GSI1SK: project.name,
      },
      row("PROJECT#recover-delete", "APITOKEN"),
    ]);
    vi.spyOn(store, "deletePartition").mockRejectedValueOnce(new Error("connection reset"));

    await expect(
      deleteProject(projectRepository, project.name, OWNER),
    ).rejects.toThrow("connection reset");
    await expect(
      deleteProject(projectRepository, project.name, OTHER),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteProject(projectRepository, project.name, OWNER)).resolves.toBeUndefined();

    expect(keysOf()).toEqual([row("PROJECT#recover-delete", "META")]);
    expect(await store.getItem(row("PROJECT#recover-delete", "META"))).toMatchObject({
      entityType: "PROJECT_TOMBSTONE",
      name: project.name,
    });
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
        projectType: "agent",
        ownerEmail: OWNER,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});



describe("model capability validation", () => {
  it("rejects a tools-incapable model on an agent project with ValidationError", async () => {
    await expect(
      writeSettings(
        settingsFixture(),
        makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
        "p",
        { ...configurationInput(), model: "xai/grok-imagine-image" },
        OWNER,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects structuredOutput on a model without the capability", async () => {
    await expect(
      writeSettings(
        settingsFixture(),
        makeProjectRepo([projectFixture("p")]),
        "p",
        {
          ...configurationInput(),
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
      writeSettings(
        settingsFixture(),
        makeProjectRepo([projectFixture("p")]),
        "p",
        {
          ...configurationInput(),
          model: "bedrock/qwen3-coder-next",
          parameters: { piiFiltering: false, reasoningTrace: true },
        },
        OWNER,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("accepts reasoningTrace on a model that does", async () => {
    const created = await writeSettings(
      settingsFixture(),
      makeProjectRepo([projectFixture("p")]),
      "p",
      {
        ...configurationInput(),
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
      const created = await writeSettings(
        settingsFixture(),
        makeProjectRepo([projectFixture("p", { projectType: "agent" })]),
        "p",
        { ...configurationInput(), model: "custom/next-gen" },
        OWNER,
      );
      expect(created.model).toBe("custom/next-gen");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("presence penalty validation", () => {
  it.each([-2, 0, 1.5, 2])("preserves a supported penalty %s", (presencePenalty) => {
    expect(agentParametersSchema.parse({ presencePenalty }).presencePenalty).toBe(presencePenalty);
  });
  it.each([-2.1, 2.1, NaN, Infinity, "1.5"])("rejects invalid penalty %s", (presencePenalty) => {
    expect(agentParametersSchema.safeParse({ presencePenalty }).success).toBe(false);
  });
  it("keeps the provider default when the setting is omitted", () => {
    expect(agentParametersSchema.parse({})).not.toHaveProperty("presencePenalty");
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

describe("configurationSchema", () => {
  it("accepts a binding with header overrides, including a null removal", () => {
    const parsed = configurationSchema.safeParse({
      mcpList: [{ name: "alpha", headers: { Authorization: "Bearer x", "X-Gone": null } }],
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.mcpList?.[0]?.headers).toEqual({
      Authorization: "Bearer x",
      "X-Gone": null,
    });
  });

  it("rejects a binding with no server name", () => {
    expect(configurationSchema.safeParse({ mcpList: [{ headers: {} }] }).success).toBe(false);
    expect(configurationSchema.safeParse({ mcpList: [""] }).success).toBe(false);
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

  it("rejects remote image URLs", () => {
    const parsed = chatMessageSchema.safeParse({
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects non-image and unsupported image data URLs", () => {
    for (const url of [
      "file:///etc/passwd",
      "http://example.com/a.png",
      "data:text/html,x",
      "data:image/png;base64,!!!!",
    ]) {
      const parsed = chatMessageSchema.safeParse({
        role: "user",
        content: [{ type: "image_url", image_url: { url } }],
      });
      expect(parsed.success, url).toBe(false);
    }
    expect(
      chatMessageSchema.safeParse({
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/svg+xml;base64,PHN2Zz4=" } },
        ],
      }).success,
    ).toBe(false);
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

  it("rejects more images than one turn may carry", () => {
    const parsed = chatMessageSchema.safeParse({
      role: "user",
      content: Array(5).fill(imagePart),
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
describe("an Agent's MCP tool narrowing survives a round trip", () => {
  const TOOLS = ["search", "fetch"];

  it("is stored by create and comes back on the view", async () => {
    const settings = settingsFixture();
    const projects = makeProjectRepo([projectFixture("p", { projectType: "agent" })]);

    const created = await writeSettings(
      settings,
      projects,
      "p",
      { ...configurationInput(), mcpList: [{ name: "real-mcp", tools: TOOLS }] },
      "owner@x.com",
    );

    expect(created.mcpList).toEqual([{ name: "real-mcp", tools: TOOLS }]);
    expect(settingsView(created).mcpList).toEqual([{ name: "real-mcp", tools: TOOLS }]);
  });

  it("is kept by update", async () => {
    const settings = settingsFixture();
    const projects = makeProjectRepo([projectFixture("p", { projectType: "agent" })]);
    await writeSettings(
      settings,
      projects,
      "p",
      { ...configurationInput(), mcpList: [{ name: "real-mcp" }] },
      "owner@x.com",
    );

    const updated = await patchSettings(
      settings,
      projects,
      "p",
      { mcpList: [{ name: "real-mcp", tools: TOOLS }] },
      "owner@x.com",
    );

    expect(updated.mcpList).toEqual([{ name: "real-mcp", tools: TOOLS }]);
  });

  it("survives alongside a header override, and masking does not eat it", async () => {
    const settings = settingsFixture();
    const projects = makeProjectRepo([projectFixture("p", { projectType: "agent" })]);

    const created = await writeSettings(
      settings,
      projects,
      "p",
      {
        ...configurationInput(),
        mcpList: [{ name: "real-mcp", tools: TOOLS, headers: { Authorization: "Bearer secret" } }],
      },
      "owner@x.com",
    );

    expect(created.mcpList[0]?.tools).toEqual(TOOLS);
    // The view masks the header; the narrowing beside it is not a secret and
    // must be reported as it is.
    expect(settingsView(created).mcpList[0]?.tools).toEqual(TOOLS);
  });
});
