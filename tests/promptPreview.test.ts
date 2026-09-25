import { createToolSchemaValidator } from "@/infrastructure/llm/toolSchema";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// MCP requests go through the SSRF-guarded fetch; forward it to the stubbed
// global so a scripted JSON-RPC server can answer without DNS or undici.
vi.mock("@/infrastructure/net/publicFetch", () => ({
  fetchPublicUrl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
}));

import { executeAgent, previewPrompt } from "@/application/execution/runAgent";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { mcpSessionFactory } from "@/infrastructure/mcp/sessionFactory";
import type { UrlPolicy } from "@/domain/security/urlPolicy";

// Allow every URL: these tests are about the run loop, not the SSRF policy.
// Injected rather than module-mocked, now that the policy is a port.
const testUrlPolicy: UrlPolicy = { async assertAllowed() {} };
import type { ExecutionDeps } from "@/application/execution/runAgent";
import { clearMcpDiscoveryCache } from "@/infrastructure/mcp/discoveryCache";
import type { ImageChannel } from "@/domain/llm/imageChannel";
import type { EngineChunk } from "@/domain/llm/types";
import type { Agent, AgentConfiguration } from "@/domain/agent/types";
import { contentChunk, FakeChannel, usageChunk } from "./fakeChannel";
import { fakeSkillRepository } from "./fakeSkills";
import { conforming, modernResult, protocolPreamble } from "./mcpProtocolStub";

const MCP_URL = "https://crm.test/mcp";

function agentFixture(): Agent {
  return {
    name: "helper",
    displayName: "Helper",
    description: "",
    ownerEmail: "owner@example.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function configurationFixture(): AgentConfiguration {
  return {
    agentName: "helper",

    systemPrompt: "You are helpful.",

    model: "gpt-test",
    parameters: { piiFiltering: false },
    mcpList: [],
    skillList: [],
    subagentList: [],
  };
}

/** A configuration bound to a skill, an MCP server and a subagent. */
function boundConfiguration(): AgentConfiguration {
  return {
    ...configurationFixture(),
    skillList: ["greeting"],
    mcpList: [{ name: "crm" }],
    subagentList: [{ name: "painter" }],
  };
}

/** Pinned so the clock line a prompt carries is deterministic. */
const TEST_NOW = new Date("2026-07-30T06:12:00Z");
/** What {@link TEST_NOW} renders as, behind the engine-block boundary. */
const CLOCK_LINE =
  'Current date and time: 2026-07-30 (Thursday) 06:12 UTC. Resolve anything relative — "today", "yesterday", "last week", "this quarter" — from this line rather than from what you remember.';

function executionDepsFixture(channel: FakeChannel) {
  const reject = () => Promise.reject(new Error("not used in this test"));
  const imageChannel = {
    async generateImage() {
      throw new Error("not used in this test");
    },
    async editImage() {
      throw new Error("not used in this test");
    },
  } as unknown as ImageChannel;
  return {
    agents: { get: reject },
    skills: fakeSkillRepository(reject),
    mcps: { get: reject },
    usage: { record: async () => {} },
    createToolSchemaValidator,
    channel,
    imageChannel,
    cipher: secretCipher,
    urlPolicy: testUrlPolicy,
    mcpSessions: mcpSessionFactory,
    now: () => TEST_NOW,
  } as unknown as ExecutionDeps;
}

/** Answer the MCP handshake with `toolNames`, recording every request's verb. */
function stubMcpServer(toolNames: string[], responseText = "ok"): { verbs: string[] } {
  const verbs: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      verbs.push(init?.method ?? "GET");
      if (init?.method === "DELETE") {
        return new Response("", { status: 204 });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
      const preamble = protocolPreamble(body.method, body.id, init?.method);
      if (preamble) {
        return preamble;
      }
      const result = modernResult(body.method, {
        ...(body.method === "tools/list"
          ? { tools: conforming(toolNames.map((name) => ({ name }))) }
          : { content: [{ type: "text", text: responseText }] }),
      });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return { verbs };
}

function wireRegistry(deps: ExecutionDeps): void {
  deps.skills.get = (async (name: string) =>
    name === "greeting"
      ? { name, description: "Says hi", content: "# Greeting" }
      : null) as ExecutionDeps["skills"]["get"];
  deps.mcps.get = (async (name: string) =>
    name === "crm"
      ? { name, url: MCP_URL, description: "Sales CRM", headers: {} }
      : null) as ExecutionDeps["mcps"]["get"];
  deps.agents.get = (async (name: string) =>
    name === "painter"
      ? { ...agentFixture(), name, description: "Draws things" }
      : null) as ExecutionDeps["agents"]["get"];
}

async function drain(gen: AsyncGenerator<EngineChunk>): Promise<void> {
  for await (const _ of gen) {
    // consume
  }
}

beforeEach(() => {
  // Discovery is cached process-wide; one test's tool list would otherwise
  // answer the next test's preview.
  clearMcpDiscoveryCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("previewPrompt", () => {
  it("uses recalled context to show the prompt and capabilities for a request", async () => {
    const deps = executionDepsFixture(new FakeChannel([]));
    stubMcpServer(["recall"], "유정열은 opspresso 조직 소속이다.");
    deps.mcps.get = (async (name: string) => ({
      name,
      url: MCP_URL,
      description: name === "memory" ? "Agent memory" : "Search opspresso documents",
      headers: {},
    })) as ExecutionDeps["mcps"]["get"];
    deps.catalog = {
      embeddings: {
        embed: async (texts) => texts.map((text) => [text.includes("opspresso") ? 1 : 0]),
      },
      catalog: {
        upsert: async () => {},
        deleteByKeys: async () => {},
        listKeys: async () => [],
        query: async (vector, _limit, filter) =>
          vector[0] === 1 && filter?.kind === "mcpServer"
            ? [{
                key: "mcp#org-records",
                score: 0.9,
                metadata: {
                  name: "org-records",
                  description: "Search opspresso documents",
                },
              }]
            : [],
      },
    };
    const preview = await previewPrompt(deps, {
      agent: agentFixture(),
      configuration: {
        ...configurationFixture(),
        mcpList: [{ name: "memory" }],
        parameters: {
          piiFiltering: false,
          memoryRecall: true,
          dynamicCapabilities: true,
        },
      },
      message: "유정열을 검색해서 정리해",
      actor: { kind: "user", id: "reader@example.com" },
    });

    expect(preview.discovered).toContain("org-records");
    expect(preview.messages[0]?.content).toContain("## What you remember");
    expect(preview.messages[0]?.content).toContain("유정열은 opspresso 조직 소속이다.");
    expect(preview.messages[0]?.content).toContain("org-records");
    expect(preview.warnings).toEqual([]);
  });

  it("returns exactly the system prompt the run would send", async () => {
    // The whole point of the panel. A second implementation of the assembly
    // would drift, and the reader would be shown a prompt nobody sends.
    const channel = new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]);
    const deps = executionDepsFixture(channel);
    wireRegistry(deps);
    stubMcpServer(["query", "update"]);
    const configuration = boundConfiguration();

    const preview = await previewPrompt(deps, { agent: agentFixture(), configuration });
    await drain(
      executeAgent(deps, {
        agent: agentFixture(),
        configuration,
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    const sent = channel.seenParams[0]?.messages[0];
    expect(sent?.role).toBe("system");
    expect(preview.messages).toEqual([{ role: "system", content: sent?.content }]);
    // And it is the assembled prompt, not the configuration's own text.
    const content = String(preview.messages[0]?.content);
    expect(content).toContain("## Available Skills");
    expect(content).toContain("Sales CRM");
    expect(content).toContain("query, update");
    expect(content).toContain("painter");
    // The clock is in the preview too. The model reads that line, so a panel
    // that hid it would be showing a prompt nobody sends — the same drift the
    // shared assembly exists to prevent.
    expect(content).toContain(CLOCK_LINE);
  });

  it("reports the tool names the model is offered", async () => {
    const deps = executionDepsFixture(new FakeChannel([]));
    wireRegistry(deps);
    stubMcpServer(["query"]);

    const preview = await previewPrompt(deps, {
      agent: agentFixture(),
      configuration: boundConfiguration(),
    });

    // `dispatch_agents` rides along with the transfer tool: a preview stands for
    // a top-level run, and that is the only kind offered fan-out.
    expect(preview.toolNames).toEqual([
      "query",
      "Skill",
      "handoff_painter",
      "delegate_painter",
    ]);
    expect(preview.tools.map((tool) => tool.name)).toEqual(preview.toolNames);
    expect(preview.tools.find((tool) => tool.name === "delegate_painter")).toMatchObject({
      description: expect.stringContaining("Ask painter"),
      parameters: expect.objectContaining({ required: ["input", "image_ids"] }),
    });
  });

  it("closes the MCP connection it opened without talking to the server", async () => {
    // Preview is the first path that opens a connection outside a run. There is
    // no session to release in this revision, so what teardown must not do is
    // put a request on the wire nobody asked for.
    const deps = executionDepsFixture(new FakeChannel([]));
    wireRegistry(deps);
    const server = stubMcpServer(["query"]);

    await previewPrompt(deps, { agent: agentFixture(), configuration: boundConfiguration() });

    expect(server.verbs).not.toContain("DELETE");
    expect(server.verbs.every((verb) => verb === "POST")).toBe(true);
  });

  it("reports a binding it could not use instead of quietly omitting it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const deps = executionDepsFixture(new FakeChannel([]));
      wireRegistry(deps);
      stubMcpServer(["query"]);
      deps.skills.get = (async () => null) as ExecutionDeps["skills"]["get"];

      const preview = await previewPrompt(deps, {
        agent: agentFixture(),
        configuration: boundConfiguration(),
      });

      expect(preview.warnings.some((w) => w.includes("greeting"))).toBe(true);
      expect(String(preview.messages[0]?.content)).not.toContain("## Available Skills");
    } finally {
      warn.mockRestore();
    }
  });

  it("says so when PII filtering will rewrite what is sent", async () => {
    const deps = executionDepsFixture(new FakeChannel([]));

    const preview = await previewPrompt(deps, {
      agent: { ...agentFixture() },
      configuration: { ...configurationFixture(), parameters: { piiFiltering: true } },
    });

    expect(preview.warnings.some((w) => w.includes("PII"))).toBe(true);
  });

  /**
   * A configuration with discovery on sends a prompt its author never typed, and this
   * panel is the only place they can read it before a run happens. A preview
   * that skipped the search would describe a smaller prompt than the configuration
   * actually sends — the same drift the caller block once had, and silent.
   */
  describe("with capability discovery on", () => {
    /** A catalog that answers one skill, and records what it was asked. */
    function catalogFor(queries: string[][]) {
      return {
        embeddings: {
          embed: async (texts: readonly string[]) => {
            queries.push([...texts]);
            return texts.map(() => [1]);
          },
        },
        catalog: {
          upsert: async () => {},
          deleteByKeys: async () => {},
          listKeys: async () => [],
          query: async (_v: readonly number[], _k: number, filter?: Record<string, unknown>) =>
            filter?.kind === "skill"
              ? [{ key: "skill#greeting", score: 0.9, metadata: { name: "greeting", description: "Says hi" } }]
              : [],
        },
      };
    }

    it("shows a capability the search found, not just what the configuration bound", async () => {
      const queries: string[][] = [];
      const deps = executionDepsFixture(new FakeChannel([]));
      wireRegistry(deps);
      deps.catalog = catalogFor(queries);

      const preview = await previewPrompt(deps, {
        agent: agentFixture(),
        configuration: {
          ...configurationFixture(),
          parameters: { piiFiltering: false, dynamicCapabilities: true },
        },
        message: "say hello to the customer",
      });

      const system = preview.messages.find((m) => m.role === "system")?.content ?? "";
      expect(system).toContain("greeting");
      // Reported as a gain rather than a warning: the panel is the only place an
      // author can see which rows the configuration never bound, and the whole point
      // is that nothing went wrong.
      expect(preview.discovered).toEqual(["greeting"]);
      expect(preview.warnings).toEqual([]);
    });

    it("searches on the preview request instead of generic persona instructions", async () => {
      // Which capabilities a run finds depends on what it is being asked, so a
      // preview that ignored the request could only ever show the floor.
      const queries: string[][] = [];
      const deps = executionDepsFixture(new FakeChannel([]));
      wireRegistry(deps);
      deps.catalog = catalogFor(queries);

      await previewPrompt(deps, {
        agent: agentFixture(),
        configuration: {
          ...configurationFixture(),
          parameters: { piiFiltering: false, dynamicCapabilities: true },
        },
        message: "say hello to the customer",
      });

      expect(queries[0]).toEqual(["say hello to the customer"]);
    });

    it("previews the floor every run starts from when no request is given", async () => {
      const queries: string[][] = [];
      const deps = executionDepsFixture(new FakeChannel([]));
      wireRegistry(deps);
      deps.catalog = catalogFor(queries);

      const preview = await previewPrompt(deps, {
        agent: agentFixture(),
        configuration: {
          ...configurationFixture(),
          parameters: { piiFiltering: false, dynamicCapabilities: true },
        },
      });

      expect(queries[0]).toEqual(["You are helpful."]);
      expect(preview.messages.find((m) => m.role === "system")?.content).toContain("greeting");
    });

    it("leaves a configuration that did not opt in exactly as it was", async () => {
      const queries: string[][] = [];
      const deps = executionDepsFixture(new FakeChannel([]));
      wireRegistry(deps);
      deps.catalog = catalogFor(queries);

      const preview = await previewPrompt(deps, {
        agent: agentFixture(),
        configuration: configurationFixture(),
        message: "say hello to the customer",
      });

      expect(queries).toEqual([]);
      expect(preview.messages.find((m) => m.role === "system")?.content).not.toContain("greeting");
    });
  });
});
