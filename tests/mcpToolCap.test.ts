import { beforeEach, describe, expect, it, vi } from "vitest";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { mcpSessionFactory } from "@/infrastructure/mcp/sessionFactory";
import { clearMcpDiscoveryCache } from "@/infrastructure/mcp/discoveryCache";
import { buildMcpTools } from "@/application/execution/mcpTools";
import { MAX_MCP_TOOLS_PER_RUN } from "@/domain/llm/toolLimits";
import type { UrlPolicy } from "@/domain/security/urlPolicy";
import type { ExecutionDeps } from "@/application/execution/deps";
import type { McpServer } from "@/domain/mcp/types";
import type { Version } from "@/domain/project/types";
import { conforming, protocolPreamble } from "./mcpProtocolStub";

vi.mock("@/infrastructure/net/publicFetch", () => ({
  fetchPublicUrl: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
}));

/**
 * The per-run tool cap, at the two places it has to mean the same thing.
 *
 * It decided what a run *offers* and nothing else: the alias map inside the
 * manager still held every discovered tool, so a cut name that arrived at
 * dispatch executed and reported an ordinary result — while the run's warning
 * said those tools "were not offered". The model does not have to invent the
 * name for that to matter; a chat replays an earlier run's top-level tool calls,
 * and the earlier run may have had room this one does not.
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
      const result =
        body.method === "tools/list"
          ? {
              tools: conforming(
                Array.from({ length: toolCount }, (_, i) => ({ name: `tool_${i}` })),
              ),
            }
          : { content: [{ type: "text", text: "ran" }] };
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
  return {
    mcps: { get: async () => server, list: reject, put: reject, delete: reject },
    cipher: secretCipher,
    urlPolicy: allow,
    mcpSessions: mcpSessionFactory,
    mcpAuth: { headersFor: async () => ({ headers: {} }), markUnauthorized: async () => {} },
  } as unknown as ExecutionDeps;
}

const version = { projectName: "p", mcpList: [{ name: "srv" }] } as unknown as Version;

describe("the per-run MCP tool cap", () => {
  beforeEach(() => {
    clearMcpDiscoveryCache();
    vi.unstubAllGlobals();
  });

  it("offers at most the cap, and says what it left out", async () => {
    stubServerWith(MAX_MCP_TOOLS_PER_RUN + 5);

    const resolved = await buildMcpTools(depsFor(), version);

    expect(resolved.mcpTools).toHaveLength(MAX_MCP_TOOLS_PER_RUN);
    expect(resolved.warnings.join(" ")).toContain("5 MCP tool(s) were not offered");
  });

  it("refuses a tool it cut rather than running it and reporting a result", async () => {
    stubServerWith(MAX_MCP_TOOLS_PER_RUN + 5);
    const resolved = await buildMcpTools(depsFor(), version);
    const cut = `tool_${MAX_MCP_TOOLS_PER_RUN + 1}`;

    const result = await resolved.callMcpTool?.(cut, {});

    expect(result?.text).toContain("Error:");
    expect(result?.text).toContain(cut);
    expect(result?.text).not.toContain("ran");
  });

  it("still dispatches a tool it did offer", async () => {
    stubServerWith(MAX_MCP_TOOLS_PER_RUN + 5);
    const resolved = await buildMcpTools(depsFor(), version);

    const result = await resolved.callMcpTool?.("tool_0", {});

    expect(result?.text).toBe("ran");
  });
});
