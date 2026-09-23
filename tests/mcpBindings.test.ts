import { createToolSchemaValidator } from "@/infrastructure/llm/toolSchema";
// A 32-byte key must be present before the encryption module reads config.
process.env.AES_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MCP_TOOLS_PER_RUN } from "@/domain/llm/toolLimits";
import { BUILTIN_TOOL_NAMES } from "@/application/llm/agentAssembly";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { mcpSessionFactory } from "@/infrastructure/mcp/sessionFactory";
import type { UrlPolicy } from "@/domain/security/urlPolicy";

// Allow every URL: these tests are about the run loop, not the SSRF policy.
// Injected rather than module-mocked, now that the policy is a port.
const testUrlPolicy: UrlPolicy = { async assertAllowed() {} };
import { clearMcpDiscoveryCache } from "@/infrastructure/mcp/discoveryCache";
import { hasMcpHeaderSecrets, mcpHeaderTarget } from "@/application/mcpHeaderTarget";

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
import type { McpBinding, Project, AgentConfiguration } from "@/domain/project/types";
import type { RunActor, RunConversation } from "@/domain/execution/actor";
import { getCachedDiscovery } from "@/infrastructure/mcp/discoveryCache";
import {
  mcpHeadersContext,
  agentMcpHeadersContext,
} from "@/domain/security/secretContext";
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
    ownerEmail: "owner@example.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function configurationFixture(projectName: string, mcpList: McpBinding[]): AgentConfiguration {
  return {
    projectName,

    systemPrompt: "",

    model: "gpt-test",
    parameters: { piiFiltering: false },
    mcpList: mcpList.map((binding) =>
      hasMcpHeaderSecrets(binding.headers) && !binding.headerTarget
        ? { ...binding, headerTarget: mcpHeaderTarget(registryServer.url) }
        : binding,
    ),
    skillList: [],
    subagentList: [],
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
    skills: fakeSkillRepository(reject),
    mcps: { get: async () => server, list: reject, put: reject, delete: reject },
    usage: {
      record: async (_delta: UsageDelta) => {},
      getDay: async () => null,
      claimAlert: async () => false,
      listActorsByProject: reject,
      listByProject: reject,
      listByDateRange: reject,
    },
    createToolSchemaValidator,
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
  overrides: Parameters<typeof depsFixture>[1] & {
    actor?: RunActor;
    conversation?: RunConversation;
    ownerEmail?: string;
  } = {},
): Promise<Record<string, string>> {
  const seen = stubMcpServer();
  try {
    const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
    const chunks: EngineChunk[] = [];
    for await (const chunk of executeAgent(depsFixture(channel, overrides), {
      project: projectFixture(projectName),
      configuration: configurationFixture(projectName, mcpList),
      messages: [{ role: "user", content: "hi" }],
      ...(overrides.actor ? { actor: overrides.actor } : {}),
      ...(overrides.conversation ? { conversation: overrides.conversation } : {}),
      ...(overrides.ownerEmail ? { ownerEmail: overrides.ownerEmail } : {}),
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
  it("decrypts context-bound registry and Agent binding headers together", async () => {
    const server = {
      ...registryServer,
      headers: encryptHeaders(
        { Authorization: "Bearer registry", "X-Shared": "shared" },
        mcpHeadersContext("shared-mcp"),
      ),
    };
    const headers = await dispatchHeaders(
      "bound",
      [
        {
          name: "shared-mcp",
          headers: encryptHeaderOverrides(
            { Authorization: "Bearer project" },
            agentMcpHeadersContext("bound", "shared-mcp"),
          ),
        },
      ],
      { server },
    );

    expect(headers.authorization).toBe("Bearer project");
    expect(headers["x-shared"]).toBe("shared");
  });

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

  it.each([
    [{ kind: "user", id: "Member@Example.com" }, "member@example.com"],
    [{ kind: "project-token", id: "Owner@Example.com" }, "owner@example.com"],
  ] as const)("names an email actor on every request", async (actor, email) => {
    const headers = await dispatchHeaders("painter", [{ name: "shared-mcp" }], { actor });

    expect(headers["x-user-email"]).toBe(email);
    expect(
      getCachedDiscovery(MCP_URL, {
        Authorization: "Bearer registry-default",
        "X-Shared": "shared-value",
        "X-Tenant-Id": "painter",
        "X-User-Email": email,
      }),
    ).toMatchObject({ kind: "tools" });
  });

  it("does not let configured headers impersonate a run actor", async () => {
    const headers = await dispatchHeaders(
      "painter",
      [
        {
          name: "shared-mcp",
          headers: encryptHeaderOverrides({ "x-user-email": "forged@example.com" }),
        },
      ],
      { actor: { kind: "user", id: "member@example.com" } },
    );

    expect(headers["x-user-email"]).toBe("member@example.com");
  });

  it("removes configured user email when the run actor has none", async () => {
    const headers = await dispatchHeaders(
      "painter",
      [
        {
          name: "shared-mcp",
          headers: encryptHeaderOverrides({ "X-User-Email": "forged@example.com" }),
        },
      ],
      { actor: { kind: "slack", id: "U123" } },
    );

    expect(headers["x-user-email"]).toBeUndefined();
  });

  it("uses a user email resolved separately from a non-email actor", async () => {
    const headers = await dispatchHeaders("painter", [{ name: "shared-mcp" }], {
      actor: { kind: "slack", id: "U123" },
      ownerEmail: "Slack.User@Example.com",
    });

    expect(headers["x-user-email"]).toBe("slack.user@example.com");
  });

  it("names the run's conversation on every request, outside the discovery cache key", async () => {
    // What lets a stateful server (a memory server) tell one thread's working
    // notes from the project's shared knowledge — and what must *not* cost a
    // full discovery per thread: the tenant keys the cache, the conversation
    // only travels.
    const conversation: RunConversation = { surface: "slack", id: "C1:1723.45" };
    const headers = await dispatchHeaders("painter", [{ name: "shared-mcp" }], { conversation });

    expect(headers["x-conversation-id"]).toBe("slack:C1:1723.45");
    expect(headers["x-tenant-id"]).toBe("painter");
    // Cached under the identity headers alone: a second thread finds the entry.
    expect(
      getCachedDiscovery(MCP_URL, {
        Authorization: "Bearer registry-default",
        "X-Shared": "shared-value",
        "X-Tenant-Id": "painter",
      }),
    ).toMatchObject({ kind: "tools" });
  });

  it("sends no conversation header for a run that has no conversation", async () => {
    const headers = await dispatchHeaders("painter", [{ name: "shared-mcp" }]);

    expect(headers["x-conversation-id"]).toBeUndefined();
  });

  it("a binding cannot name another conversation either", async () => {
    const headers = await dispatchHeaders(
      "painter",
      [
        {
          name: "shared-mcp",
          headers: encryptHeaderOverrides({ "x-conversation-id": "chat:not-mine" }),
        },
      ],
      { conversation: { surface: "chat", id: "mine" } },
    );

    expect(headers["x-conversation-id"]).toBe("chat:mine");
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
    // Discovering OAuth on an entry adds a way to authenticate it. It would
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

  it("drops an unavailable-auth server whose only stored headers are reserved metadata", async () => {
    // A stored spelling of X-Tenant-Id or X-User-Email is not "a way to
    // authenticate": stripped before the availability check, it leaves the
    // header map empty and the server is skipped with the connection's reason
    // — instead of being dispatched bare on the strength of headers that were
    // about to be thrown away.
    const oauthServer = {
      ...registryServer,
      headers: encryptHeaders({
        "X-Tenant-Id": "forged-project",
        "X-User-Email": "forged@example.com",
      }),
      auth: { type: "oauth2", resource: "https://shared-mcp.test" },
    } as unknown as typeof registryServer;

    const seen = stubMcpServer();
    try {
      const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
      const chunks: EngineChunk[] = [];
      for await (const chunk of executeAgent(
        depsFixture(channel, {
          server: oauthServer,
          mcpAuth: {
            headersFor: async () => ({
              headers: {},
              unavailable:
                "MCP server 'shared-mcp' requires authorization and this project has not connected it.",
            }),
            markUnauthorized: async () => {},
          },
        }),
        {
          project: projectFixture("no-connection"),
          configuration: configurationFixture("no-connection", [{ name: "shared-mcp" }]),
          messages: [{ role: "user", content: "hi" }],
        },
      )) {
        chunks.push(chunk);
      }
      expect(seen).toHaveLength(0);
      expect(chunks.some((chunk) => chunk.warning?.includes("requires authorization"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("does not send Agent binding credentials after the registry endpoint moves", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const movedServer = {
      ...registryServer,
      url: "https://moved-mcp.test/mcp",
      headers: {},
    };

    const headers = await dispatchHeaders(
      "moved",
      [
        {
          name: "shared-mcp",
          headers: encryptHeaderOverrides({ Authorization: "Bearer old-endpoint-token" }),
          headerTarget: mcpHeaderTarget(registryServer.url),
        },
      ],
      { server: movedServer },
    );

    expect(headers.authorization).toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("moved since its Agent header credentials were saved"),
    );
    warning.mockRestore();
  });

  it("keeps using the registry URL — a binding may redefine headers only", async () => {
    const seen = stubMcpServer();
    try {
      const channel = new FakeChannel([[contentChunk("ok"), usageChunk(1, 1)]]);
      const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
      for await (const _chunk of executeAgent(depsFixture(channel), {
        project: projectFixture("url-check"),
        configuration: configurationFixture("url-check", [
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
        configuration: configurationFixture("p", mcpList),
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
    const many = Array.from({ length: MAX_MCP_TOOLS_PER_RUN + 10 }, (_, index) => `tool_${index}`);

    const { names, warnings } = await offeredTools([{ name: "shared-mcp" }], many);

    expect(names).toHaveLength(MAX_MCP_TOOLS_PER_RUN);
    expect(
      warnings.some((warning) => warning.includes(`at most ${MAX_MCP_TOOLS_PER_RUN}`)),
    ).toBe(true);
  });

  it("leaves the builtins room inside the provider's own limit", async () => {
    // The cap is 128 minus the builtins, so it moves when they do. At 120 with
    // thirteen builtins a full run declared 133 and the provider rejected it
    // outright — the failure the cap exists to prevent, caused by the cap.
    expect(MAX_MCP_TOOLS_PER_RUN + BUILTIN_TOOL_NAMES.length).toBeLessThanOrEqual(128);
  });
});
