/**
 * What a run is offered when its version opted into discovery.
 *
 * The load-bearing property is that discovery is *additive*: a version's own
 * bindings are resolved in full and in order, and nothing a search finds can
 * displace, reorder or truncate them. A project turning this on has to be able
 * to do so without re-auditing what it already relies on — so that is what most
 * of these pin.
 *
 * The catalog is a fake store rather than a stubbed `searchCapabilities`, so the
 * real ranking runs. How it ranks is `catalog.test.ts`'s subject; what happens
 * to its answer is this file's.
 */

import { describe, expect, it } from "vitest";
import { resolveRunTools } from "@/application/execution/bindings";
import type { CatalogSearchDeps } from "@/application/catalog/searchCatalog";
import type { CapabilityKind } from "@/domain/catalog/types";
import type { McpServerConfig } from "@/domain/mcp/toolSession";
import type { McpServer } from "@/domain/mcp/types";
import type { Version } from "@/domain/project/types";
import type { VectorMatch } from "@/domain/vector/types";

const TIME = "2026-01-01T00:00:00Z";

function version(overrides: Partial<Version> = {}): Version {
  return {
    projectName: "proj",
    versionName: "v1",
    systemPrompt: "You review pull requests.",
    userPromptTemplate: "",
    model: "gpt-5.2",
    parameters: { piiFiltering: false, dynamicCapabilities: true },
    mcpList: [],
    skillList: [],
    subagentList: [],
    createdAt: TIME,
    ...overrides,
  };
}

function server(name: string, auth?: McpServer["auth"]): McpServer {
  return {
    name,
    url: "https://example.test/mcp",
    description: "",
    headers: {},
    ...(auth ? { auth } : {}),
    createdAt: TIME,
    updatedAt: TIME,
  };
}

const OAUTH: McpServer["auth"] = {
  type: "oauth2",
  resource: "https://example.test",
  authorizationServer: "https://as.example.test",
  authorizationEndpoint: "https://as.example.test/authorize",
  tokenEndpoint: "https://as.example.test/token",
  tokenEndpointAuthMethod: "none",
  discoveredAt: TIME,
};

const found = (name: string, toolName?: string, score = 0.9): VectorMatch => ({
  key: toolName ? `t#${name}#${toolName}` : `x#${name}`,
  score,
  metadata: { name, description: "", ...(toolName ? { toolName } : {}) },
});

function fakeCatalog(
  byKind: Partial<Record<CapabilityKind, VectorMatch[]>>,
  error?: Error,
): CatalogSearchDeps {
  return {
    embeddings: { embed: async (texts) => texts.map(() => [1]) },
    catalog: {
      upsert: async () => {},
      deleteByKeys: async () => {},
      listKeys: async () => [],
      query: async (_vector, _topK, filter) => {
        if (error) {
          throw error;
        }
        return byKind[filter?.kind as CapabilityKind] ?? [];
      },
    },
  };
}

interface Harness {
  deps: Parameters<typeof resolveRunTools>[0];
  /** Servers `buildMcpTools` was asked to open, i.e. what actually got bound. */
  opened: McpServerConfig[][];
}

function harness(
  options: {
    catalog?: CatalogSearchDeps;
    servers?: McpServer[];
    connections?: Array<{ serverName: string; status: string }>;
  } = {},
): Harness {
  const registry = new Map((options.servers ?? []).map((entry) => [entry.name, entry]));
  const opened: McpServerConfig[][] = [];
  return {
    opened,
    deps: {
      skills: {
        describe: async (names: readonly string[]) =>
          names.map((name) => ({ name, description: `about ${name}` })),
      },
      externalAgents: { get: async (name: string) => ({ name, description: `agent ${name}` }) },
      projects: { get: async () => null },
      mcps: { get: async (name: string) => registry.get(name) ?? null },
      mcpConnections: { listByProject: async () => options.connections ?? [] },
      ...(options.catalog ? { catalog: options.catalog } : {}),
      cipher: { mergeOutboundHeaders: () => ({}) },
      urlPolicy: { assertAllowed: async () => {} },
      mcpSessions: {
        open: async (servers: McpServerConfig[]) => {
          opened.push(servers);
          return {
            tools: [],
            toolNamesByServer: new Map(),
            warnings: [],
            unauthorizedServers: [],
            callTool: async () => ({}),
            close: async () => {},
          };
        },
      },
      mcpAuth: { headersFor: async () => ({ headers: {} }), markUnauthorized: async () => {} },
    } as unknown as Parameters<typeof resolveRunTools>[0],
  };
}

const QUERIES = ["You review pull requests.", "open a PR for this"];

describe("capability discovery", () => {
  it("offers nothing beyond the bindings when the version did not opt in", async () => {
    const { deps } = harness({ catalog: fakeCatalog({ skill: [found("discovered")] }) });
    const resolved = await resolveRunTools(
      deps,
      version({ parameters: { piiFiltering: false }, skillList: ["bound"] }),
      undefined,
      QUERIES,
    );
    expect(resolved.skills.map((skill) => skill.name)).toEqual(["bound"]);
  });

  it("says so when the version asked for discovery and the deployment has no catalog", async () => {
    // Nothing else can tell the author: the checkbox stays ticked, the bindings
    // resolve, the run answers normally and the preview shows the same prompt.
    const { deps } = harness();
    const resolved = await resolveRunTools(deps, version({ skillList: ["bound"] }), undefined, QUERIES);
    expect(resolved.skills.map((skill) => skill.name)).toEqual(["bound"]);
    expect(resolved.warnings).toEqual([
      "This version is set to find capabilities for each request, but this deployment has no capability catalog; only its own bindings were offered.",
    ]);
  });

  it("stays silent for a version that never asked for discovery", async () => {
    const { deps } = harness();
    const resolved = await resolveRunTools(
      deps,
      version({ parameters: { piiFiltering: false }, skillList: ["bound"] }),
      undefined,
      QUERIES,
    );
    expect(resolved.warnings).toEqual([]);
  });

  it("says so when there is nothing to search with", async () => {
    const { deps } = harness({ catalog: fakeCatalog({ skill: [found("discovered")] }) });
    const resolved = await resolveRunTools(deps, version({ systemPrompt: "" }), undefined, []);
    expect(resolved.warnings.some((line) => line.includes("nothing to search with"))).toBe(true);
    expect(resolved.skills).toEqual([]);
  });

  it("appends what it finds after the bindings, never in front of them", async () => {
    const { deps } = harness({ catalog: fakeCatalog({ skill: [found("discovered")] }) });
    const resolved = await resolveRunTools(
      deps,
      version({ skillList: ["bound-a", "bound-b"] }),
      undefined,
      QUERIES,
    );
    expect(resolved.skills.map((skill) => skill.name)).toEqual([
      "bound-a",
      "bound-b",
      "discovered",
    ]);
  });

  it("does not offer a capability twice when the search finds one already bound", async () => {
    const { deps } = harness({ catalog: fakeCatalog({ skill: [found("bound")] }) });
    const resolved = await resolveRunTools(deps, version({ skillList: ["bound"] }), undefined, QUERIES);
    expect(resolved.skills.map((skill) => skill.name)).toEqual(["bound"]);
  });

  it("binds a discovered server narrowed to the tools that matched", async () => {
    // `McpBinding.tools` exists for exactly this: a server found for one tool
    // should not spend the run's tool budget on the rest of its catalogue.
    const { deps, opened } = harness({
      catalog: fakeCatalog({
        mcpTool: [found("github", "create_pr"), found("github", "add_comment", 0.85)],
      }),
      servers: [server("github")],
    });
    await resolveRunTools(deps, version(), undefined, QUERIES);
    expect(opened[0]).toEqual([
      expect.objectContaining({ name: "github", tools: ["create_pr", "add_comment"] }),
    ]);
  });

  it("finds a server whose tools were never listed, through its server entry", async () => {
    // A server that refused discovery when the catalog was built has no tool
    // rows at all. Searching tools alone would make it permanently
    // undiscoverable — which is most of the point of indexing servers
    // separately. It binds whole, and the dispatch-time listing decides.
    const { deps, opened } = harness({
      catalog: fakeCatalog({ mcpServer: [found("github")] }),
      servers: [server("github")],
    });
    await resolveRunTools(deps, version(), undefined, QUERIES);
    expect(opened[0]).toEqual([expect.objectContaining({ name: "github" })]);
    expect(opened[0]?.[0]).not.toHaveProperty("tools");
  });

  it("binds a server reached both ways once, narrowed to its matched tools", async () => {
    const { deps, opened } = harness({
      catalog: fakeCatalog({
        mcpTool: [found("github", "list_repos")],
        mcpServer: [found("github")],
      }),
      servers: [server("github")],
    });
    await resolveRunTools(deps, version(), undefined, QUERIES);
    expect(opened[0]).toEqual([
      expect.objectContaining({ name: "github", tools: ["list_repos"] }),
    ]);
  });

  it("refuses an OAuth server this project has not connected", async () => {
    const { deps, opened } = harness({
      catalog: fakeCatalog({ mcpTool: [found("slack", "post")] }),
      servers: [server("slack", OAUTH)],
    });
    const resolved = await resolveRunTools(deps, version(), undefined, QUERIES);
    expect(opened).toEqual([]);
    expect(resolved.warnings.some((line) => line.includes("has not connected it"))).toBe(true);
  });

  it("offers an OAuth server this project *has* connected", async () => {
    // Authorizing a server in the console says this project may use it, and
    // discovery has no business being the one caller that ignores that. The
    // connection rows answer by being read — resolving the credential would
    // refresh tokens and make discovery a writer.
    const { deps, opened } = harness({
      catalog: fakeCatalog({ mcpTool: [found("slack", "post")] }),
      servers: [server("slack", OAUTH)],
      connections: [{ serverName: "slack", status: "connected" }],
    });
    const resolved = await resolveRunTools(deps, version(), undefined, QUERIES);
    expect(opened[0]).toEqual([expect.objectContaining({ name: "slack", tools: ["post"] })]);
    expect(resolved.warnings.some((line) => line.includes("has not connected it"))).toBe(false);
  });

  it("treats a connection still awaiting the person as not connected", async () => {
    // `needs_auth` and `needs_reauth` are rows the console shows as unfinished.
    const { deps, opened } = harness({
      catalog: fakeCatalog({ mcpTool: [found("slack", "post")] }),
      servers: [server("slack", OAUTH)],
      connections: [{ serverName: "slack", status: "needs_reauth" }],
    });
    await resolveRunTools(deps, version(), undefined, QUERIES);
    expect(opened).toEqual([]);
  });

  it("hands back the widened version, so a discovered agent can be transferred to", async () => {
    // Offering an agent and being able to reach it are decided by two different
    // lists: `subagents` is what the model is told, while `buildSubagentRunner`
    // builds the dispatch map from a version's `subagentList`. Given the
    // caller's own version, every discovered agent answered `Unknown agent` the
    // moment the model used it — advertised, in the transfer enum, unreachable.
    const { deps } = harness({ catalog: fakeCatalog({ agent: [found("docs-bot")] }) });
    const resolved = await resolveRunTools(deps, version(), undefined, QUERIES);
    expect(resolved.subagents.map((entry) => entry.name)).toEqual(["docs-bot"]);
    expect(resolved.version.subagentList).toEqual([{ name: "docs-bot", type: "remote" }]);
  });

  it("leaves the version untouched when nothing was discovered", async () => {
    const { deps } = harness();
    const bound = version({ skillList: ["bound"] });
    const resolved = await resolveRunTools(deps, bound, undefined, QUERIES);
    expect(resolved.version).toBe(bound);
  });

  it("reports what it added as a gain, not as a warning", async () => {
    // Reported through `discovered` rather than `warnings`: a capability found
    // is the opposite of a loss, and routing it through the loss channel made
    // every healthy run of a discovery-enabled version report a warning — a
    // yellow alert on every chat turn and a non-empty `warnings` in every
    // answer.
    const { deps } = harness({
      catalog: fakeCatalog({ skill: [found("a-skill")], agent: [found("an-agent")] }),
    });
    const resolved = await resolveRunTools(deps, version(), undefined, QUERIES);
    expect(resolved.discovered).toEqual(["a-skill", "an-agent"]);
    expect(resolved.warnings).toEqual([]);
  });

  it("keeps running on the bindings when the catalog fails", async () => {
    // An unreachable catalog must not take the run with it: the version's own
    // bindings are still exactly what it asked for.
    const { deps } = harness({
      catalog: fakeCatalog({}, new Error("index unavailable")),
    });
    const resolved = await resolveRunTools(deps, version({ skillList: ["bound"] }), undefined, QUERIES);
    expect(resolved.skills.map((skill) => skill.name)).toEqual(["bound"]);
    expect(resolved.warnings.some((line) => line.includes("discovery failed"))).toBe(true);
  });
});
