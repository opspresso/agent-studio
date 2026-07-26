import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// MCP requests go through the SSRF-guarded fetch; forward it to the stubbed
// global so a scripted JSON-RPC server can answer without DNS or undici.
vi.mock("@/infrastructure/net/publicFetch", () => ({
  fetchPublicUrl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
}));

import { executeAgent, previewPrompt } from "@/application/execution/runProject";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { mcpSessionFactory } from "@/infrastructure/mcp/sessionFactory";
import type { UrlPolicy } from "@/domain/security/urlPolicy";

// Allow every URL: these tests are about the run loop, not the SSRF policy.
// Injected rather than module-mocked, now that the policy is a port.
const testUrlPolicy: UrlPolicy = { async assertAllowed() {} };
import type { ExecutionDeps } from "@/application/execution/runProject";
import { clearMcpDiscoveryCache } from "@/infrastructure/mcp/discoveryCache";
import type { ImageChannel } from "@/domain/llm/imageChannel";
import type { EngineChunk } from "@/domain/llm/types";
import type { Project, Version } from "@/domain/project/types";
import { contentChunk, FakeChannel, usageChunk } from "./fakeChannel";

const MCP_URL = "https://crm.test/mcp";

function projectFixture(): Project {
  return {
    name: "helper",
    displayName: "Helper",
    description: "",
    projectType: "agent",
    ownerEmail: "owner@example.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function versionFixture(): Version {
  return {
    projectName: "helper",
    versionName: "v1",
    systemPrompt: "You are helpful.",
    userPromptTemplate: "",
    model: "gpt-test",
    parameters: { piiFiltering: false },
    mcpList: [],
    skillList: [],
    subagentList: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/** A version bound to a skill, an MCP server and a subagent. */
function boundVersion(): Version {
  return {
    ...versionFixture(),
    skillList: ["greeting"],
    mcpList: [{ name: "crm" }],
    subagentList: [{ name: "painter", type: "local" }],
  };
}

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
    projects: { get: reject },
    versions: { get: reject },
    skills: { get: reject },
    mcps: { get: reject },
    externalAgents: { get: reject },
    usage: { record: async () => {} },
    channel,
    imageChannel,
    cipher: secretCipher,
    urlPolicy: testUrlPolicy,
    mcpSessions: mcpSessionFactory,
  } as unknown as ExecutionDeps;
}

/** Answer the MCP handshake with `toolNames`, recording every request's verb. */
function stubMcpServer(toolNames: string[]): { verbs: string[] } {
  const verbs: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      verbs.push(init?.method ?? "GET");
      if (init?.method === "DELETE") {
        return new Response("", { status: 204 });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      const result =
        body.method === "tools/list"
          ? { tools: toolNames.map((name) => ({ name })) }
          : { protocolVersion: "2025-06-18", capabilities: {} };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json", "Mcp-Session-Id": "s-1" },
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
  deps.projects.get = (async (name: string) =>
    name === "painter"
      ? { ...projectFixture(), name, description: "Draws things" }
      : null) as ExecutionDeps["projects"]["get"];
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
  it("returns exactly the system prompt the run would send", async () => {
    // The whole point of the panel. A second implementation of the assembly
    // would drift, and the reader would be shown a prompt nobody sends.
    const channel = new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]);
    const deps = executionDepsFixture(channel);
    wireRegistry(deps);
    stubMcpServer(["query", "update"]);
    const version = boundVersion();

    const preview = await previewPrompt(deps, { project: projectFixture(), version });
    await drain(
      executeAgent(deps, {
        project: projectFixture(),
        version,
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    const sent = channel.seenParams[0]?.messages[0];
    expect(sent?.role).toBe("system");
    expect(preview.messages).toEqual([{ role: "system", content: sent?.content }]);
    // And it is the assembled prompt, not the version's own text.
    const content = String(preview.messages[0]?.content);
    expect(content).toContain("## Available Skills");
    expect(content).toContain("Sales CRM");
    expect(content).toContain("query, update");
    expect(content).toContain("painter");
  });

  it("reports the tool names the model is offered", async () => {
    const deps = executionDepsFixture(new FakeChannel([]));
    wireRegistry(deps);
    stubMcpServer(["query"]);

    const preview = await previewPrompt(deps, {
      project: projectFixture(),
      version: boundVersion(),
    });

    expect(preview.toolNames).toEqual(["query", "Skill", "transfer_to_agent"]);
  });

  it("releases the MCP session it opened", async () => {
    // Preview is the first path that opens a session outside a run; one leaked
    // per refresh would undo the teardown the run path just gained.
    const deps = executionDepsFixture(new FakeChannel([]));
    wireRegistry(deps);
    const server = stubMcpServer(["query"]);

    await previewPrompt(deps, { project: projectFixture(), version: boundVersion() });

    expect(server.verbs).toContain("DELETE");
  });

  it("reports a binding it could not use instead of quietly omitting it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const deps = executionDepsFixture(new FakeChannel([]));
      wireRegistry(deps);
      stubMcpServer(["query"]);
      deps.skills.get = (async () => null) as ExecutionDeps["skills"]["get"];

      const preview = await previewPrompt(deps, {
        project: projectFixture(),
        version: boundVersion(),
      });

      expect(preview.warnings.some((w) => w.includes("greeting"))).toBe(true);
      expect(String(preview.messages[0]?.content)).not.toContain("## Available Skills");
    } finally {
      warn.mockRestore();
    }
  });

  it("tells an agent project that its user prompt template is never sent", async () => {
    const deps = executionDepsFixture(new FakeChannel([]));
    wireRegistry(deps);
    stubMcpServer(["query"]);

    const preview = await previewPrompt(deps, {
      project: projectFixture(),
      version: { ...boundVersion(), userPromptTemplate: "Answer {{topic}}." },
    });

    expect(preview.warnings.some((w) => w.includes("user prompt template"))).toBe(true);
  });

  it("renders a prompt project's template with its variables", async () => {
    const deps = executionDepsFixture(new FakeChannel([]));

    const preview = await previewPrompt(deps, {
      project: { ...projectFixture(), projectType: "llm" },
      version: {
        ...versionFixture(),
        systemPrompt: "You summarize.",
        userPromptTemplate: "Summarize {{topic}} in one line.",
      },
      variables: { topic: "otters" },
    });

    expect(preview.messages).toEqual([
      { role: "system", content: "You summarize." },
      { role: "user", content: "Summarize otters in one line." },
    ]);
    expect(preview.toolNames).toEqual([]);
  });

  it("previews an image project's rendered prompt, which is all it sends", async () => {
    const deps = executionDepsFixture(new FakeChannel([]));

    const preview = await previewPrompt(deps, {
      project: { ...projectFixture(), projectType: "image" },
      version: { ...versionFixture(), userPromptTemplate: "A {{animal}} in watercolour" },
      variables: { animal: "otter" },
    });

    expect(preview.messages).toEqual([{ role: "user", content: "A otter in watercolour" }]);
  });

  it("says so when PII filtering will rewrite what is sent", async () => {
    const deps = executionDepsFixture(new FakeChannel([]));

    const preview = await previewPrompt(deps, {
      project: { ...projectFixture(), projectType: "llm" },
      version: { ...versionFixture(), parameters: { piiFiltering: true } },
    });

    expect(preview.warnings.some((w) => w.includes("PII"))).toBe(true);
  });
});
