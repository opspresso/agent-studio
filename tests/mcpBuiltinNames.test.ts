// A 32-byte key must be present before the encryption module reads config.
process.env.AES_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

import { beforeEach, describe, expect, it, vi } from "vitest";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { mcpSessionFactory } from "@/infrastructure/mcp/sessionFactory";
import type { UrlPolicy } from "@/domain/security/urlPolicy";

// Allow every URL: these tests are about the run loop, not the SSRF policy.
// Injected rather than module-mocked, now that the policy is a port.
const testUrlPolicy: UrlPolicy = { async assertAllowed() {} };
import { clearMcpDiscoveryCache } from "@/infrastructure/mcp/discoveryCache";

// MCP dispatch goes through the SSRF-guarded fetch; forward it to the stubbed
// global so a scripted JSON-RPC server can answer without DNS or undici.
vi.mock("@/infrastructure/net/publicFetch", () => ({
  fetchPublicUrl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
}));
import { executeAgent } from "@/application/execution/runProject";
import type { ExecutionDeps } from "@/application/execution/runProject";
import { encryptHeaders } from "@/infrastructure/crypto/secretEncryption";
import type { ImageChannel } from "@/domain/llm/imageChannel";
import type { EngineChunk } from "@/domain/llm/types";
import type { Project, Version } from "@/domain/project/types";
import { contentChunk, FakeChannel, toolCallChunk, usageChunk } from "./fakeChannel";

/** An MCP server whose tool is named exactly like a builtin. */
const registryServer = {
  name: "shadow-mcp",
  url: "https://shadow-mcp.test/mcp",
  description: "exposes tools named like builtins",
  headers: encryptHeaders({}),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function projectFixture(): Project {
  return {
    name: "painter",
    displayName: "painter",
    description: "",
    projectType: "agent",
    ownerEmail: "owner@example.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function versionFixture(overrides: Partial<Version> = {}): Version {
  return {
    projectName: "painter",
    versionName: "v1",
    systemPrompt: "",
    userPromptTemplate: "",
    model: "gpt-test",
    parameters: { piiFiltering: false },
    mcpList: [{ name: "shadow-mcp" }],
    skillList: [],
    subagentList: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function depsFixture(channel: FakeChannel) {
  const reject = () => Promise.reject(new Error("not used in this test"));
  const imageChannel = {
    async generateImage() {
      return {
        b64: "aW1n",
        mimeType: "image/png",
        usage: { textInputTokens: 1, imageInputTokens: 0, imageOutputTokens: 1 },
      };
    },
    editImage: reject,
  } as unknown as ImageChannel;
  return {
    projects: { get: reject, list: reject, put: reject, delete: reject },
    versions: { get: reject, list: reject, put: reject, delete: reject },
    skills: { get: reject, list: reject, put: reject, delete: reject },
    mcps: { get: async () => registryServer, list: reject, put: reject, delete: reject },
    externalAgents: { get: reject, list: reject, put: reject, delete: reject },
    usage: {
      record: async () => {},
      getDay: async () => null,
      claimAlert: async () => false,
      listActorsByProject: reject,
      listByProject: reject,
      listByDateRange: reject,
    },
    channel,
    imageChannel,
    cipher: secretCipher,
    urlPolicy: testUrlPolicy,
    mcpSessions: mcpSessionFactory,
  } as unknown as ExecutionDeps;
}

/** Answer the JSON-RPC handshake, recording every `tools/call` name. */
function stubMcpServer(toolNames: string[]): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
        id?: number;
        params?: { name?: string };
      };
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      let result: unknown = {};
      if (body.method === "tools/list") {
        result = { tools: toolNames.map((name) => ({ name })) };
      } else if (body.method === "tools/call") {
        calls.push(body.params?.name ?? "");
        result = { content: [{ type: "text", text: "mcp answered" }] };
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return { calls };
}

async function run(
  channel: FakeChannel,
  version: Version,
): Promise<{ chunks: EngineChunk[]; toolNames: string[] }> {
  const chunks: EngineChunk[] = [];
  for await (const chunk of executeAgent(depsFixture(channel), {
    project: projectFixture(),
    version,
    messages: [{ role: "user", content: "go" }],
  })) {
    chunks.push(chunk);
  }
  return { chunks, toolNames: (channel.seenParams[0]?.tools ?? []).map((t) => t.function.name) };
}

beforeEach(() => {
  // Discovery is cached process-wide; a stale entry would answer the next
  // test's init and hide the request it is asserting on.
  clearMcpDiscoveryCache();
});

describe("an MCP tool named like a builtin", () => {
  it("is aliased even when that builtin is inactive, so it stays callable", async () => {
    // No skills connected: the Skill builtin is NOT offered this run. The MCP
    // tool must still be reachable — reserving only the active builtins would
    // leave it named `Skill`, which the engine's builtin branch would swallow.
    const { calls } = stubMcpServer(["Skill"]);
    try {
      const channel = new FakeChannel([
        [toolCallChunk(0, "call_1", "Skill_1", '{"q":"x"}'), usageChunk(1, 1)],
        [contentChunk("done"), usageChunk(1, 1)],
      ]);
      const { chunks, toolNames } = await run(channel, versionFixture());

      expect(toolNames).toEqual(["Skill_1"]);
      expect(calls).toEqual(["Skill"]);
      expect(chunks.find((c) => c.toolResult)?.toolResult?.content).toBe("mcp answered");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never produces two tools with the same name when the builtin is active", async () => {
    // Duplicate function names in one request are rejected by some providers and
    // silently disambiguated by others; either way the MCP tool was unreachable.
    const { calls } = stubMcpServer(["GenerateImage", "EditImage"]);
    try {
      const channel = new FakeChannel([
        [
          toolCallChunk(0, "call_1", "GenerateImage", '{"prompt":"a cat"}'),
          toolCallChunk(1, "call_2", "GenerateImage_1", "{}"),
          usageChunk(1, 1),
        ],
        [contentChunk("done"), usageChunk(1, 1)],
      ]);
      const { chunks, toolNames } = await run(
        channel,
        versionFixture({ parameters: { piiFiltering: false, imageGeneration: true } }),
      );

      expect(new Set(toolNames).size).toBe(toolNames.length);
      expect(toolNames).toEqual(
        expect.arrayContaining(["GenerateImage_1", "EditImage_1", "GenerateImage", "EditImage"]),
      );
      // The builtin served `GenerateImage`; the MCP tool served its alias.
      expect(chunks.some((c) => c.image)).toBe(true);
      expect(calls).toEqual(["GenerateImage"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
