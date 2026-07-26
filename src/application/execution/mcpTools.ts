/** A version's MCP bindings resolved into offered tools, and session cleanup. */

import type { Project, SubagentRef, Version } from "@/domain/project/types";
import type { McpServerConfig, McpSessionFactory } from "@/domain/mcp/toolSession";
import { BlockedUrlError, type UrlPolicy } from "@/domain/security/urlPolicy";
import * as engine from "@/application/llm/engine";
import type { ExecutionDeps } from "./deps";

/**
 * MCP tools one run may declare. Providers reject a request that declares too
 * many (OpenAI's own limit is 128), and the whole run fails with it — so the
 * tail is dropped and reported instead.
 */
export const MAX_MCP_TOOLS_PER_RUN = 120;

export type ResolvedMcp = Awaited<ReturnType<typeof buildMcpTools>>;

export async function buildMcpTools(
  deps: ExecutionDeps,
  version: Version,
  signal?: AbortSignal,
): Promise<{
  mcpTools: import("@/domain/llm/channel").ChannelToolDef[];
  mcpServers: engine.McpServerInfo[];
  callMcpTool?: engine.AgentDeps["callMcpTool"];
  /** Why a bound server contributed no tools; surfaced to the user by the run. */
  warnings: string[];
  /** Releases the MCP sessions; call in a `finally` once the run is over. */
  close?: () => Promise<void>;
}> {
  const mcpList = version.mcpList ?? [];
  if (mcpList.length === 0) {
    return { mcpTools: [], mcpServers: [], warnings: [] };
  }
  const descriptionByName = new Map<string, string>();
  const resolved = await Promise.all(
    mcpList.map(
      async (binding): Promise<{ server?: McpServerConfig; description?: string; warning?: string }> => {
        const mcp = await deps.mcps.get(binding.name);
        if (!mcp) {
          console.warn(`[run] MCP server '${binding.name}' is not in the registry; skipping it`);
          return {
            warning: `MCP server '${binding.name}' is no longer in the registry; its tools were not offered.`,
          };
        }
        try {
          // Re-check at dispatch (like remote subagents) to narrow the DNS-rebinding
          // window; a blocked server is skipped, not fatal to the run. The URL is
          // always the registry's — a binding may redefine headers, never the host.
          await deps.urlPolicy.assertAllowed(mcp.url);
        } catch (error) {
          const reason = error instanceof BlockedUrlError ? error.message : String(error);
          console.warn(`Skipping MCP server '${mcp.name}': ${reason}`);
          return { warning: `MCP server '${mcp.name}' was blocked: ${reason}` };
        }
        return {
          server: {
            name: mcp.name,
            url: mcp.url,
            headers: deps.cipher.mergeOutboundHeaders(mcp.headers, binding.headers),
            ...(binding.tools && binding.tools.length > 0 ? { tools: binding.tools } : {}),
          },
          description: mcp.description ?? "",
        };
      },
    ),
  );
  const warnings: string[] = [];
  const servers: McpServerConfig[] = [];
  for (const entry of resolved) {
    if (entry.warning) {
      warnings.push(entry.warning);
    }
    if (entry.server) {
      servers.push(entry.server);
      descriptionByName.set(entry.server.name, entry.description ?? "");
    }
  }

  // Every builtin name is reserved, not just the ones this version activates:
  // aliases are allocated here, before the engine decides which builtins to
  // offer, and a name that a builtin *may* claim must never resolve to an MCP
  // tool the engine would then shadow.
  // The factory releases anything it opened if discovery fails, so a run
  // cancelled mid-init leaks nothing.
  const toolManager = await deps.mcpSessions.open(servers, engine.BUILTIN_TOOL_NAMES, signal);
  // Providers cap how many tools one request may declare, and a request over
  // that limit fails outright — losing the tail is strictly better than losing
  // the run. Builtins are added after this, so leave them room.
  const capped = toolManager.tools.slice(0, MAX_MCP_TOOLS_PER_RUN);
  const droppedTools = toolManager.tools.length - capped.length;
  const offered = new Set(capped.map((tool) => tool.function.name));
  const mcpServers: engine.McpServerInfo[] = [];
  for (const [serverName, toolNames] of toolManager.toolNamesByServer) {
    const visible = toolNames.filter((name) => offered.has(name));
    if (visible.length > 0) {
      mcpServers.push({
        name: serverName,
        description: descriptionByName.get(serverName) ?? "",
        toolNames: visible,
      });
    }
  }
  return {
    mcpTools: capped,
    mcpServers,
    warnings: [
      ...warnings,
      ...toolManager.warnings,
      ...(droppedTools > 0
        ? [
            `${droppedTools} MCP tool(s) were not offered: a run may declare at most ${MAX_MCP_TOOLS_PER_RUN}. Narrow a binding's tool selection.`,
          ]
        : []),
    ],
    callMcpTool: (name, args) => toolManager.callTool(name, args),
    close: () => toolManager.close(),
  };
}

/** Release MCP sessions without ever failing the run that just finished. */
export async function closeMcp(close: (() => Promise<void>) | undefined): Promise<void> {
  if (!close) {
    return;
  }
  try {
    await close();
  } catch (error) {
    console.warn("[mcp] session cleanup failed", error);
  }
}
