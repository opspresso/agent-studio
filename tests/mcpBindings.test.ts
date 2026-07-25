// A 32-byte key must be present before the encryption module reads config.
process.env.AES_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

import { describe, expect, it, vi } from "vitest";

// MCP dispatch goes through the SSRF-guarded fetch; forward it to the stubbed
// global so a scripted JSON-RPC server can answer without DNS or undici.
vi.mock("@/infrastructure/net/publicFetch", () => ({
  fetchPublicUrl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
}));
vi.mock("@/infrastructure/net/ssrfGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/infrastructure/net/ssrfGuard")>();
  return { ...actual, assertPublicUrl: async () => {} };
});

import { executeAgent } from "@/application/execution/runProject";
import type { ExecutionDeps } from "@/application/execution/runProject";
import { encryptHeaderOverrides, encryptHeaders } from "@/infrastructure/crypto/secretEncryption";
import type { ImageChannel } from "@/domain/llm/imageChannel";
import type { EngineChunk } from "@/domain/llm/types";
import type { McpBinding, Project, Version } from "@/domain/project/types";
import type { UsageDelta } from "@/domain/usage/types";
import { contentChunk, FakeChannel, usageChunk } from "./fakeChannel";

const MCP_URL = "https://shared-mcp.test/mcp";

/** One shared registry server both projects bind to. */
const registryServer = {
  name: "shared-mcp",
  url: MCP_URL,
  description: "shared",
  headers: encryptHeaders({
    Authorization: "Bearer registry-default",
    "X-Shared": "shared-value",
  }),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function projectFixture(name: string): Project {
  return {
    name,
    displayName: name,
    description: "",
    projectType: "agent",
    ownerEmail: "owner@example.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function versionFixture(projectName: string, mcpList: McpBinding[]): Version {
  return {
    projectName,
    versionName: "v1",
    systemPrompt: "",
    userPromptTemplate: "",
    model: "gpt-test",
    parameters: { piiFiltering: false },
    mcpList,
    skillList: [],
    subagentList: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function depsFixture(channel: FakeChannel) {
  const reject = () => Promise.reject(new Error("not used in this test"));
  const imageChannel = { generateImage: reject } as unknown as ImageChannel;
  return {
    projects: { get: reject, list: reject, put: reject, delete: reject },
    versions: { get: reject, list: reject, put: reject, delete: reject },
    skills: { get: reject, list: reject, put: reject, delete: reject },
    mcps: { get: async () => registryServer, list: reject, put: reject, delete: reject },
    externalAgents: { get: reject, list: reject, put: reject, delete: reject },
    usage: {
      record: async (_delta: UsageDelta) => {},
      listByProject: reject,
      listByDateRange: reject,
    },
    channel,
    imageChannel,
  } as unknown as ExecutionDeps;
}

/** Record the headers every MCP request carried, answering the JSON-RPC handshake. */
function stubMcpServer(): Array<Record<string, string>> {
  const seen: Array<Record<string, string>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      const result = body.method === "tools/list" ? { tools: [{ name: "search" }] } : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return seen;
}

/** Run one agent turn and return the headers the MCP server was called with. */
async function dispatchHeaders(
  projectName: string,
  mcpList: McpBinding[],
): Promise<Record<string, string>> {
  const seen = stubMcpServer();
  try {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    const chunks: EngineChunk[] = [];
    for await (const chunk of executeAgent(depsFixture(channel), {
      project: projectFixture(projectName),
      version: versionFixture(projectName, mcpList),
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }
    expect(chunks.some((c) => c.error)).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
    return seen[0]!;
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("per-project MCP header overrides at dispatch", () => {
  it("sends the registry headers unchanged when a binding has no override", async () => {
    const headers = await dispatchHeaders("plain", [{ name: "shared-mcp" }]);

    expect(headers.authorization).toBe("Bearer registry-default");
    expect(headers["x-shared"]).toBe("shared-value");
  });

  it("lets two projects call one registry server with different credentials", async () => {
    const a = await dispatchHeaders("tenant-a", [
      { name: "shared-mcp", headers: encryptHeaderOverrides({ Authorization: "Bearer token-a" }) },
    ]);
    const b = await dispatchHeaders("tenant-b", [
      { name: "shared-mcp", headers: encryptHeaderOverrides({ Authorization: "Bearer token-b" }) },
    ]);

    expect(a.authorization).toBe("Bearer token-a");
    expect(b.authorization).toBe("Bearer token-b");
    // The shared registry header neither binding touched still reaches both.
    expect(a["x-shared"]).toBe("shared-value");
    expect(b["x-shared"]).toBe("shared-value");
  });

  it("applies overwrite, add, and remove in one binding", async () => {
    const headers = await dispatchHeaders("mixed", [
      {
        name: "shared-mcp",
        headers: encryptHeaderOverrides({
          Authorization: "Bearer overwritten",
          "X-Tenant": "acme",
          "X-Shared": null,
        }),
      },
    ]);

    expect(headers.authorization).toBe("Bearer overwritten");
    expect(headers["x-tenant"]).toBe("acme");
    expect(headers["x-shared"]).toBeUndefined();
  });

  it("keeps using the registry URL — a binding may redefine headers only", async () => {
    const seen = stubMcpServer();
    try {
      const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
      const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
      for await (const _chunk of executeAgent(depsFixture(channel), {
        project: projectFixture("url-check"),
        version: versionFixture("url-check", [
          {
            name: "shared-mcp",
            headers: encryptHeaderOverrides({ Authorization: "Bearer x" }),
          },
        ]),
        messages: [{ role: "user", content: "hi" }],
      })) {
        // drain
      }
      expect(seen.length).toBeGreaterThan(0);
      for (const call of fetchMock.mock.calls) {
        expect(String(call[0])).toBe(MCP_URL);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
