import { createHash } from "node:crypto";
/** An Agent's MCP bindings resolved into offered tools, and session cleanup. */

import type { AgentConfiguration } from "@/domain/project/types";
import { conversationKey, type RunOrigin } from "@/domain/execution/actor";
import type { McpServerConfig } from "@/domain/mcp/toolSession";
import { BlockedUrlError } from "@/domain/security/urlPolicy";
import { skipsUrlGuard } from "@/domain/mcp/types";
import { MAX_MCP_TOOLS_PER_RUN } from "@/domain/llm/toolLimits";
import { agentToolName } from "@/domain/llm/toolNames";
import { runtimeFingerprint } from "@/application/runtime/session";
import * as engine from "@/application/runtime";
import {
  applyMcpUserEmail,
  CONVERSATION_ID_HEADER,
  mcpUserEmail,
  stripMcpMetadataHeaders,
  TENANT_ID_HEADER,
} from "@/application/mcpMetadataHeaders";
import { hasMcpHeaderSecrets, mcpHeaderTarget } from "@/application/mcpHeaderTarget";
import type { ExecutionDeps } from "./deps";
import { log } from "@/shared/logger";
import { mapMcpSource, MCP_SOURCE_RESULT_DESCRIPTION } from "@/application/audio/mapMcpSource";
import {
  mcpHeadersContext,
  agentMcpHeadersContext,
} from "@/domain/security/secretContext";

export type ResolvedMcp = Awaited<ReturnType<typeof buildMcpTools>>;

/** What resolving an Agent's MCP bindings actually reads off the run's deps. */
export type McpToolDeps = Pick<
  ExecutionDeps,
  "mcps" | "cipher" | "urlPolicy" | "mcpSessions" | "mcpAuth" | "internalHostSuffixes" | "registerMcpSource" | "sourceRefreshIdentity"
>;

export async function buildMcpTools(
  deps: McpToolDeps,
  configuration: AgentConfiguration,
  signal?: AbortSignal,
  /** Where the run came from; its email actor and conversation reach the server as headers. */
  origin?: Pick<RunOrigin, "actor" | "userEmail" | "conversation"> & Partial<Pick<RunOrigin, "ancestry">>,
): Promise<{
  signature: string;
  mcpTools: import("@/domain/llm/channel").ChannelToolDef[];
  mcpServers: engine.McpServerInfo[];
  callMcpTool?: engine.AgentDeps["callMcpTool"];
  /**
   * The offered name of one server's own tool, when this run offers it — the
   * way a run addresses a tool it knows by its server's name rather than by the
   * alias the model sees (`memoryRecall.ts` asks for each server's `recall`).
   * Absent, like `callMcpTool`, when the Agent binds no server.
   */
  aliasFor?: (serverName: string, toolName: string) => string | undefined;
  /** Why a bound server contributed no tools; surfaced to the user by the run. */
  warnings: string[];
  /** Releases the MCP sessions; call in a `finally` once the run is over. */
  close?: () => Promise<void>;
}> {
  const mcpList = configuration.mcpList ?? [];
  if (mcpList.length === 0) {
    return { mcpTools: [], mcpServers: [], warnings: [], signature: runtimeFingerprint([]) };
  }
  const descriptionByName = new Map<string, string>();
  // Per-request context, kept apart from the identity headers on purpose — see
  // `CONVERSATION_ID_HEADER` for why it must not reach the discovery cache key.
  const contextHeaders: Record<string, string> | undefined = origin?.conversation
    ? { [CONVERSATION_ID_HEADER]: conversationKey(origin.conversation) }
    : undefined;
  const resolved = await Promise.all(
    mcpList.map(
      async (binding): Promise<{ server?: McpServerConfig; description?: string; warning?: string }> => {
        const mcp = await deps.mcps.get(binding.name);
        if (!mcp) {
          log.warn("run", `MCP server '${binding.name}' is not in the registry; skipping it`);
          return {
            warning: `MCP server '${binding.name}' is no longer in the registry; its tools were not offered.`,
          };
        }
        // Two kinds of entry skip the guard: a container this app started at a
        // loopback address, and a host whose suffix this deployment declared
        // internal. Both decided in one place. Everything else still faces the
        // guard here.
        const loopback = skipsUrlGuard(mcp, deps.internalHostSuffixes);
        if (!loopback) {
          try {
            // Re-check at dispatch (like remote subagents) to narrow the DNS-rebinding
            // window; a blocked server is skipped, not fatal to the run. The URL is
            // always the registry's — a binding may redefine headers, never the host.
            await deps.urlPolicy.assertAllowed(mcp.url);
          } catch (error) {
            log.warn("mcp", `skipping server '${mcp.name}'`, error);
            return { warning: error instanceof BlockedUrlError
              ? `MCP server '${mcp.name}' was blocked: ${error.message}`
              : `MCP server '${mcp.name}' could not be checked for a safe address; its tools were not offered.` };
          }
        }
        let overrides = binding.headers;
        let credentialWarning: string | undefined;
        if (
          hasMcpHeaderSecrets(overrides) &&
          binding.headerTarget !== mcpHeaderTarget(mcp.url)
        ) {
          overrides = Object.fromEntries(
            Object.entries(overrides ?? {}).filter(([, value]) => value === null),
          );
          credentialWarning =
            `MCP server '${mcp.name}' moved since its Agent header credentials were saved; ` +
            "those credentials were not sent. Re-enter them for the current endpoint.";
          log.warn("mcp", credentialWarning);
        }
        const sourceOutputs = binding.sourceOutputs ?? mcp.sourceOutputs;
        const defaults = binding.sourceOutputs === undefined && Boolean(sourceOutputs?.length);
        const refreshIdentity = defaults || sourceOutputs?.some((mapping) => mapping.refreshArgument)
          ? await deps.sourceRefreshIdentity?.({ configuration, binding, server: mcp }) : undefined;
        // Default namespaces belong to the authenticated connection, never to a shared plugin account.
        const mappings = sourceOutputs?.map((mapping) => defaults ? { ...mapping,
          namespace: createHash("sha256").update(JSON.stringify([mapping.namespace, configuration.projectName, refreshIdentity])).digest("hex") } : mapping);
        const headers = deps.cipher.mergeOutboundHeaders(
          mcp.headers,
          overrides,
          mcpHeadersContext(mcp.name),
          agentMcpHeadersContext(
            configuration.projectName,
            binding.name,
          ),
        );
        // Before the availability check below: a stored spelling of a reserved
        // metadata header must never count as "a way to authenticate" a server
        // whose connection is unavailable, and must never impersonate another
        // project, user, or conversation.
        stripMcpMetadataHeaders(headers);
        if (mcp.auth) {
          // A per-project credential, resolved and refreshed by the auth
          // provider. Applied last on purpose: an Agent must not be able to
          // substitute its own Authorization for the project's connection.
          // The entry's own OAuth block goes with it, so the provider can tell
          // whether the connection still belongs to what this name points at —
          // it is already in hand here, which keeps that check off the read path.
          const resolved = await deps.mcpAuth.headersFor(
            configuration.projectName,
            mcp.name,
            mcp.auth,
          );
          if (!resolved.unavailable) {
            Object.assign(headers, resolved.headers);
          } else if (Object.keys(headers).length === 0) {
            // Nothing else to authenticate with, so the server really is out of
            // reach. With headers of its own it is not: discovering OAuth on an
            // entry adds a way to authenticate it, and must not take away the
            // one the operator already configured.
            return {
              warning: [credentialWarning, `${resolved.unavailable} Its tools were not offered.`]
                .filter(Boolean)
                .join(" "),
            };
          }
        }
        // The platform's own values, applied last: the strip above already
        // removed every stored spelling, so nothing merged from the registry
        // or a binding survives to be folded with these.
        applyMcpUserEmail(headers, mcpUserEmail(origin?.actor, origin?.userEmail));
        headers[TENANT_ID_HEADER] = configuration.projectName;
        return {
          server: {
            name: mcp.name,
            url: mcp.url,
            ...(loopback ? { loopback: true } : {}),
            headers,
            ...(contextHeaders ? { contextHeaders } : {}),
            ...(binding.tools && binding.tools.length > 0 ? { tools: binding.tools } : {}),
            ...(mappings?.length ? { resultTransforms: Object.fromEntries(mappings.map((mapping) => [mapping.tool,
              (result: unknown) => defaults && !refreshIdentity ? Promise.resolve({ text: "Error: default file mapping requires a connection identity." }) : mapMcpSource({ result, mapping, serverName: mcp.name, projectName: origin?.ancestry?.[0] ?? configuration.projectName,
                ...(mapping.refreshArgument && refreshIdentity ? { refresh: { projectName: configuration.projectName, serverName: mcp.name, mapping, identity: refreshIdentity } } : {}),
                userEmail: mcpUserEmail(origin?.actor, origin?.userEmail), register: deps.registerMcpSource })])) } : {}),
          },
          description: mcp.description ?? "",
          ...(credentialWarning ? { warning: credentialWarning } : {}),
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

  // Every builtin name is reserved, not just the ones this Agent activates:
  // aliases are allocated here, before the engine decides which builtins to
  // offer, and a name that a builtin *may* claim must never resolve to an MCP
  // tool the engine would then shadow.
  // The factory releases anything it opened if discovery fails, so a run
  // cancelled mid-init leaks nothing.
  const reservedNames = [...engine.BUILTIN_TOOL_NAMES, ...(configuration.subagentList ?? []).flatMap((agent) => [agentToolName(agent.name, "handoff"), agentToolName(agent.name, "delegate")])];
  const toolManager = await deps.mcpSessions.open(servers, reservedNames, signal);
  // A server that rejected the token is the one failure the project itself can
  // fix. Recorded so the console offers a reconnect rather than leaving the
  // owner to re-diagnose it from a warning on every future run.
  const flagged = new Set<string>();
  const flagUnauthorized = async (): Promise<void> => {
    for (const serverName of toolManager.unauthorizedServers) {
      if (flagged.has(serverName)) {
        continue;
      }
      flagged.add(serverName);
      await deps.mcpAuth
        .markUnauthorized(configuration.projectName, serverName, toolManager.scopeChallenges?.get(serverName))
        .catch((error: unknown) => {
          log.warn("mcp", `could not flag '${serverName}' as needing reauthorization`, error);
        });
    }
  };
  await flagUnauthorized();
  // Providers cap how many tools one request may declare, and a request over
  // that limit fails outright — losing the tail is strictly better than losing
  // the run. Builtins are added after this, so leave them room.
  const mappedAliases = new Set(servers.flatMap((server) =>
    Object.keys(server.resultTransforms ?? {}).flatMap((name) => {
      const alias = toolManager.aliasFor(server.name, name);
      return alias ? [alias] : [];
    }),
  ));
  const capped = toolManager.tools.slice(0, MAX_MCP_TOOLS_PER_RUN).map((tool) =>
    mappedAliases.has(tool.function.name) ? {
      ...tool,
      function: { ...tool.function,
        description: [tool.function.description, MCP_SOURCE_RESULT_DESCRIPTION].filter(Boolean).join("\n\n") },
    } : tool,
  );
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
    signature: runtimeFingerprint([servers.map(({ name, url }) => ({ name, url })), capped]),
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
    // Refused rather than routed. The cap above decides what this run *offers*,
    // but the alias map inside the manager still holds every discovered tool, so
    // a name that reaches here having been cut executed anyway and reported a
    // normal result — which the warning's "were not offered" says did not
    // happen. The model does not have to invent the name for that to matter: a
    // chat replays an earlier run's top-level tool calls, and the earlier run
    // may have had room for a tool this one does not.
    // Only what this run offers: an alias past the cap above is one the model
    // was told nothing about, and a run addressing it by server and tool name
    // would call a tool it said it did not have.
    aliasFor: (serverName, toolName) => {
      const alias = toolManager.aliasFor(serverName, toolName);
      return alias && offered.has(alias) ? alias : undefined;
    },
    callMcpTool: async (name, args) => {
      if (!offered.has(name)) return { text: `Error: '${name}' is not available on this run. At most ` +
        `${MAX_MCP_TOOLS_PER_RUN} MCP tools are offered and this one was past that. Use one of the tools listed for you.` };
      return toolManager.callTool(name, args);
    },
    close: async () => {
      // Checked again on the way out, because discovery may have been served
      // from cache — in which case the run's first request to that server was a
      // tool call, and a token revoked since the last discovery can only surface
      // there. Nothing reads the flag until the next run, so the way out is
      // early enough.
      await flagUnauthorized();
      await toolManager.close();
    },
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
    log.warn("mcp", "session cleanup failed", error);
  }
}
