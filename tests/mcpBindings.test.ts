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
import { encryptHeaderOverrides, encryptHeaders } from "@/infrastructure/crypto/secretEncryption";
import type { ImageChannel } from "@/domain/llm/imageChannel";
import type { EngineChunk } from "@/domain/llm/types";
import type { McpBinding, Project, Version } from "@/domain/project/types";
import type { UsageDelta } from "@/domain/usage/types";
import { contentChunk, FakeChannel, usageChunk } from "./fakeChannel";
import { fakeSkillRepository } from "./fakeSkills";
import { conforming, modernResult, protocolPreamble } from "./mcpProtocolStub";

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

function depsFixture(
  channel: FakeChannel,
  overrides: { server?: typeof registryServer; mcpAuth?: unknown } = {},
) {
  const reject = () => Promise.reject(new Error("not used in this test"));
  const imageChannel = { generateImage: reject } as unknown as ImageChannel;
  const server = overrides.server ?? registryServer;
  return {
    ...(overrides.mcpAuth ? { mcpAuth: overrides.mcpAuth } : {}),
    projects: { get: reject, list: reject, put: reject, delete: reject },
    versions: { get: reject, list: reject, put: reject, delete: reject },
    skills: fakeSkillRepository(reject),
    mcps: { get: async () => server, list: reject, put: reject, delete: reject },
    externalAgents: { get: reject, list: reject, put: reject, delete: reject },
    usage: {
      record: async (_delta: UsageDelta) => {},
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

/** Record the headers every MCP request carried, answering the JSON-RPC handshake. */
function stubMcpServer(toolNames: string[] = ["search"]): Array<Record<string, string>> {
  const seen: Array<Record<string, string>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
      const preamble = protocolPreamble(body.method, body.id, init?.method);
      if (preamble) {
        return preamble;
      }
      const result = modernResult(body.method, {
        ...(body.method === "tools/list"
          ? { tools: conforming(toolNames.map((name) => ({ name }))) }
          : { content: [{ type: "text", text: "ok" }] }),
      });
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
  overrides: Parameters<typeof depsFixture>[1] = {},
): Promise<Record<string, string>> {
  const seen = stubMcpServer();
  try {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    const chunks: EngineChunk[] = [];
    for await (const chunk of executeAgent(depsFixture(channel, overrides), {
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

beforeEach(() => {
  // Discovery is cached process-wide; a stale entry would answer the next
  // test's init and hide the request it is asserting on.
  clearMcpDiscoveryCache();
});

describe("per-project MCP header overrides at dispatch", () => {
  it("sends the registry headers unchanged when a binding has no override", async () => {
    const headers = await dispatchHeaders("plain", [{ name: "shared-mcp" }]);

    expect(headers.authorization).toBe("Bearer registry-default");
    expect(headers["x-shared"]).toBe("shared-value");
  });

  it("names the calling project on every request, with no registration", async () => {
    // What lets a multi-tenant server (mcp-memory) scope its data per project
    // without anyone configuring a header per binding.
    const headers = await dispatchHeaders("painter", [{ name: "shared-mcp" }]);

    expect(headers["x-tenant-id"]).toBe("painter");
  });

  it("a binding cannot impersonate another project's tenant", async () => {
    // The override merge runs first and the project header is applied on top —
    // in any spelling: a case-variant surviving beside the real one would reach
    // the server as one comma-joined value, which reads as neither project.
    const headers = await dispatchHeaders("painter", [
      {
        name: "shared-mcp",
        headers: encryptHeaderOverrides({ "x-tenant-id": "other-project" }),
      },
    ]);

    expect(headers["x-tenant-id"]).toBe("painter");
  });

  it("still sends the registry headers when the entry has OAuth the project has not connected", async () => {
    // Discovering OAuth on an entry adds a way to authenticate it. It used to
    // take one away: any `auth` block made the run drop the server outright,
    // so an entry that had been working on a static Authorization header went
    // dark the moment an admin pressed Discover on it.
    const oauthServer = {
      ...registryServer,
      auth: { type: "oauth2", resource: "https://shared-mcp.test" },
    } as unknown as typeof registryServer;

    const headers = await dispatchHeaders("no-connection", [{ name: "shared-mcp" }], {
      server: oauthServer,
      mcpAuth: {
        headersFor: async () => ({
          headers: {},
          unavailable: "MCP server 'shared-mcp' requires authorization and this project has not connected it.",
        }),
        markUnauthorized: async () => {},
      },
    });

    expect(headers.authorization).toBe("Bearer registry-default");
    expect(headers["x-shared"]).toBe("shared-value");
  });

  it("prefers the project's connection over the entry's own header", async () => {
    // The connection is the more specific credential, so it wins where both
    // exist — the fallback is for projects that have not connected.
    const oauthServer = {
      ...registryServer,
      auth: { type: "oauth2", resource: "https://shared-mcp.test" },
    } as unknown as typeof registryServer;

    const headers = await dispatchHeaders("connected", [{ name: "shared-mcp" }], {
      server: oauthServer,
      mcpAuth: {
        headersFor: async () => ({ headers: { Authorization: "Bearer project-oauth" } }),
        markUnauthorized: async () => {},
      },
    });

    expect(headers.authorization).toBe("Bearer project-oauth");
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

describe("what a run may offer from a bound server", () => {
  /** Run one turn and report the tool names the channel was given, plus warnings. */
  async function offeredTools(mcpList: McpBinding[], serverTools: string[]) {
    stubMcpServer(serverTools);
    try {
      const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
      const chunks: EngineChunk[] = [];
      for await (const chunk of executeAgent(depsFixture(channel), {
        project: projectFixture("p"),
        version: versionFixture("p", mcpList),
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(chunk);
      }
      return {
        names: (channel.seenParams[0]?.tools ?? []).map((t) => t.function.name),
        warnings: chunks.flatMap((chunk) => (chunk.warning ? [chunk.warning] : [])),
      };
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("offers only the tools a binding selected", async () => {
    const { names } = await offeredTools(
      [{ name: "shared-mcp", tools: ["search"] }],
      ["search", "write", "delete"],
    );

    expect(names).toEqual(["search"]);
  });

  it("caps the tools one run declares and says how many were left out", async () => {
    // A provider rejects a request that declares too many tools, and the whole
    // run fails with it — losing the tail beats losing the run.
    const many = Array.from({ length: 130 }, (_, index) => `tool_${index}`);

    const { names, warnings } = await offeredTools([{ name: "shared-mcp" }], many);

    expect(names).toHaveLength(120);
    expect(warnings.some((warning) => warning.includes("at most 120"))).toBe(true);
  });
});
