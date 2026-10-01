import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { mcpSessionFactory } from "@/infrastructure/mcp/sessionFactory";
import { clearMcpDiscoveryCache } from "@/infrastructure/mcp/discoveryCache";
import { buildMcpTools } from "@/application/execution/mcpTools";
import { MAX_MCP_TOOLS_PER_RUN } from "@/domain/llm/toolLimits";
import type { UrlPolicy } from "@/domain/security/urlPolicy";
import type { ExecutionDeps } from "@/application/execution/deps";
import type { McpServer } from "@/domain/mcp/types";
import type { AgentConfiguration } from "@/domain/agent/types";
import { conforming, modernResult, protocolPreamble } from "./mcpProtocolStub";

vi.mock("@/infrastructure/net/publicFetch", () => ({
  fetchPublicUrl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
}));

/**
 * The per-run tool cap bounds declarations, dispatch and direct alias lookup.
 */
function stubServerWith(toolCount: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; id?: number };
      const preamble = protocolPreamble(body.method, body.id, init?.method);
      if (preamble) {
        return preamble;
      }
      const result = modernResult(body.method, {
        ...(body.method === "tools/list"
          ? {
              tools: conforming(
                Array.from({ length: toolCount }, (_, i) => ({ name: `tool_${i}` })),
              ),
            }
          : { content: [{ type: "text", text: "ran" }] }),
      });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

const allow: UrlPolicy = { async assertAllowed() {} };

function depsFor(): ExecutionDeps {
  const reject = () => Promise.reject(new Error("not used"));
  const server: McpServer = {
    name: "srv",
    url: "https://mcp.test/mcp",
    headers: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return { authorizeRun: async () => {},
    mcps: { get: async () => server, list: reject, put: reject, delete: reject },
    cipher: secretCipher,
    urlPolicy: allow,
    mcpSessions: mcpSessionFactory,
    mcpAuth: { headersFor: async () => ({ headers: {} }), markUnauthorized: async () => {} },
  } as unknown as ExecutionDeps;
}

const configuration = { agentName: "p", mcpList: [{ name: "srv" }] } as unknown as AgentConfiguration;

describe("the per-run MCP tool cap", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-01-01T00:00:00.000Z");
    clearMcpDiscoveryCache();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearMcpDiscoveryCache();
  });

  it("offers at most the cap, and says what it left out", async () => {
    stubServerWith(MAX_MCP_TOOLS_PER_RUN + 5);

    const resolved = await buildMcpTools(depsFor(), configuration);

    expect(resolved.mcpTools).toHaveLength(MAX_MCP_TOOLS_PER_RUN);
    expect(resolved.warnings.join(" ")).toContain("5 MCP tool(s) were not offered");
  });

  it("refuses a tool it cut rather than running it and reporting a result", async () => {
    stubServerWith(MAX_MCP_TOOLS_PER_RUN + 5);
    const resolved = await buildMcpTools(depsFor(), configuration);
    const cut = `tool_${MAX_MCP_TOOLS_PER_RUN + 1}`;

    const result = await resolved.callMcpTool?.(cut, {});

    expect(result?.text).toContain("Error:");
    expect(result?.text).toContain(cut);
    expect(result?.text).not.toContain("ran");
  });

  it("still dispatches a tool it did offer", async () => {
    stubServerWith(MAX_MCP_TOOLS_PER_RUN + 5);
    const resolved = await buildMcpTools(depsFor(), configuration);

    const result = await resolved.callMcpTool?.("tool_0", {});

    expect(result?.text).toBe("ran");
  });

  it("does not hand out the alias of a tool it cut, by server and name either", async () => {
    // `aliasFor` is how a run addresses a server's tool without the model — the
    // memory recall — and it must answer from the same offered set, or the cap
    // would have a side door.
    stubServerWith(MAX_MCP_TOOLS_PER_RUN + 5);
    const resolved = await buildMcpTools(depsFor(), configuration);

    expect(resolved.aliasFor?.("srv", "tool_0")).toBe("tool_0");
    expect(resolved.aliasFor?.("srv", `tool_${MAX_MCP_TOOLS_PER_RUN + 1}`)).toBeUndefined();
    expect(resolved.aliasFor?.("other", "tool_0")).toBeUndefined();
  });
});
