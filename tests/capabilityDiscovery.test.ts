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

function harness(options: {
  catalog?: CatalogSearchDeps;
  servers?: McpServer[];
} = {}): Harness {
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

  it("offers nothing beyond the bindings when the deployment has no catalog", async () => {
    const { deps } = harness();
    const resolved = await resolveRunTools(deps, version({ skillList: ["bound"] }), undefined, QUERIES);
    expect(resolved.skills.map((skill) => skill.name)).toEqual(["bound"]);
    expect(resolved.warnings).toEqual([]);
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

  it("refuses to add an MCP server that needs its own sign-in", async () => {
    // Checking whether a connection exists means asking the auth provider for
    // headers, and that refreshes tokens — a second refresh in one run races the
    // first with providers that rotate them. A connected server is one somebody
    // deliberately set up, and binding it is that same deliberate act.
    const { deps, opened } = harness({
      catalog: fakeCatalog({ mcpTool: [found("slack", "post")] }),
      servers: [server("slack", OAUTH)],
    });
    const resolved = await resolveRunTools(deps, version(), undefined, QUERIES);
    expect(opened).toEqual([]);
    expect(resolved.warnings.some((line) => line.includes("needs an authorized connection"))).toBe(
      true,
    );
  });

  it("reports what it added, so the reader sees the run was widened", async () => {
    const { deps } = harness({
      catalog: fakeCatalog({ skill: [found("a-skill")], agent: [found("an-agent")] }),
    });
    const resolved = await resolveRunTools(deps, version(), undefined, QUERIES);
    const note = resolved.warnings.find((line) => line.startsWith("Found "));
    expect(note).toContain("a-skill");
    expect(note).toContain("an-agent");
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
