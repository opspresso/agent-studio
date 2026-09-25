import { notifyConfigurationChange } from "./configurationEvents";
import type {
  CostLimits,
  McpBinding,
  Agent,
  AgentVisibility,
  SubagentRef,
  AgentConfiguration,
  AgentParameters,
} from "@/domain/agent/types";
import type { ModelConfig } from "@/domain/llm/models";
import type { McpTool } from "@/domain/mcp/types";
import type { SlackChannelInfo, SlackSuggestedPrompt } from "@/domain/slack/types";
import type { EngineChunk } from "@/domain/llm/types";
import type { UsageRow } from "@/domain/usage/types";
import type { Trace } from "@/domain/trace/types";
/**
 * The shapes the server answers with are taken from the module that produces
 * each, never restated here: a type-only import is erased, so the browser
 * bundle is unchanged and the two ends of the wire cannot drift. Restating them
 * had already cost a crash — the Slack settings page rendered a manifest a
 * mutation's narrower response did not carry.
 */
import type { McpConnectionView } from "@/application/mcp/mcpAuthUseCases";
import type { ActorUsageView, AgentActorUsage } from "@/application/usage/listActors";
import type { CloneAgentResponse } from "@/app/api/agents/[name]/clone/route";
import type { ModelsResponse } from "@/app/api/models/route";
import type { SanitizedAgent } from "@/app/api/agents/_lib/http";
import type { AgentSlackResponse } from "@/app/api/agents/[name]/slack/route";
import type { AgentTelegramResponse } from "@/app/api/agents/[name]/telegram/route";
import type { AgentTeamsResponse } from "@/app/api/agents/[name]/teams/route";
import type { PromptPreview } from "@/application/execution/deps";
import type { ApiTokenStatus } from "@/application/agent/apiTokenUseCases";
import type {
  AgentConfigurationView,
  AgentConfigurationInput,
  PutAgentConfigurationInput,
} from "@/application/agent/configurationUseCases";
import type { TelegramDestination } from "@/domain/telegram/destination";
import { assertOk, jsonHeaders, readJson } from "@/app/_lib/httpClient";
import { testMcpConnection } from "@/app/tools/api";
import { readSse as readSseFrames } from "@/app/_lib/sse";

export type { CostLimits, McpBinding, Agent, AgentVisibility, SubagentRef, AgentConfiguration, AgentParameters };
export type { ModelConfig, EngineChunk, UsageRow, Trace, SlackChannelInfo, SlackSuggestedPrompt };
export type SelectableModel = ModelsResponse["models"][number];

// --- Agents -------------------------------------------------------------

export interface CreateAgentInput {
  name: string;
  displayName: string;
  description: string;
  departmentCode?: string;
}

export interface UpdateAgentInput {
  displayName?: string;
  description?: string;
  departmentCode?: string;
  /** Sent whole; `null` removes the guards. Omitted leaves them untouched. */
  costLimits?: CostLimits | null;
  visibility?: AgentVisibility;
  /** Sent whole; replaces the invite list. Omitted leaves it untouched. */
  memberEmails?: string[];
}

// Agent responses are the sanitized shape the routes actually build —
// integrations arrive as summaries, which is what lets a page ask "is Slack
// connected" before it fires a request only a connected bot can answer.
export type { SanitizedAgent };

export function listAgents(): Promise<SanitizedAgent[]> {
  return fetch("/api/agents").then((r) => readJson<SanitizedAgent[]>(r));
}

export function getAgent(name: string): Promise<SanitizedAgent> {
  return fetch(`/api/agents/${name}`).then((r) => readJson<SanitizedAgent>(r));
}

export function createAgent(input: CreateAgentInput): Promise<SanitizedAgent> {
  return fetch("/api/agents", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }).then((r) => readJson<SanitizedAgent>(r));
}

export function updateAgent(name: string, patch: UpdateAgentInput): Promise<SanitizedAgent> {
  return fetch(`/api/agents/${name}`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(patch),
  }).then((r) => readJson<SanitizedAgent>(r));
}

export function cloneAgent(
  sourceName: string,
  input: { name: string; displayName: string },
): Promise<CloneAgentResponse> {
  return fetch(`/api/agents/${sourceName}/clone`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }).then((r) => readJson<CloneAgentResponse>(r));
}

export function deleteAgent(name: string): Promise<void> {
  return fetch(`/api/agents/${name}`, { method: "DELETE" }).then(assertOk);
}

export function listTraces(
  name: string,
  range?: { from?: string; to?: string },
): Promise<{ traces: Trace[] }> {
  const query = new URLSearchParams();
  if (range?.from) {
    query.set("from", range.from);
  }
  if (range?.to) {
    query.set("to", range.to);
  }
  const qs = query.toString();
  return fetch(`/api/agents/${name}/traces${qs ? `?${qs}` : ""}`).then((r) =>
    readJson<{ traces: Trace[] }>(r),
  );
}

export function getTrace(name: string, traceId: string): Promise<Trace> {
  return fetch(`/api/agents/${name}/traces/${traceId}`).then((r) => readJson<Trace>(r));
}

// --- Current Agent settings ------------------------------------------------

export type { AgentConfigurationInput, AgentConfigurationView, PutAgentConfigurationInput, PromptPreview };

export function getConfiguration(name: string): Promise<AgentConfigurationView> {
  return fetch(`/api/agents/${name}/configuration`).then(r => readJson<AgentConfigurationView>(r));
}

export function putConfiguration(name: string, input: PutAgentConfigurationInput): Promise<AgentConfigurationView> {
  return fetch(`/api/agents/${name}/configuration`, { method: "PUT", headers: jsonHeaders,
    body: JSON.stringify(input) }).then(r => readJson<AgentConfigurationView>(r)).then(saved => {
      notifyConfigurationChange(name);
      return saved;
    });
}

export function previewPrompt(name: string, input: AgentConfigurationInput & { message?: string }, signal?: AbortSignal): Promise<PromptPreview> {
  return fetch(`/api/agents/${name}/preview`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(input), signal })
    .then(r => readJson<PromptPreview>(r));
}

// --- Models ---------------------------------------------------------------

/** Fetch the model registry; callers decide how to report an unavailable list. */
export async function listModels(): Promise<ModelsResponse["models"]> {
  const data = await readJson<ModelsResponse>(await fetch("/api/models"));
  if (!Array.isArray(data.models)) {
    throw new Error("Model registry returned no model list");
  }
  return data.models;
}

// --- Usage ----------------------------------------------------------------

export function usageSummary(
  name: string,
  from: string,
  to: string,
): Promise<{ items: UsageRow[] }> {
  const query = new URLSearchParams({ agent: name, from, to });
  return fetch(`/api/usages/summary?${query}`).then((r) => readJson<{ items: UsageRow[] }>(r));
}

// --- Execution (SSE) ------------------------------------------------------

/** Engine-typed view over the shared SSE frame reader. */
export function readSse(response: Response): AsyncGenerator<EngineChunk> {
  return readSseFrames<EngineChunk>(response);
}

export async function streamPredict(
  name: string,
  body: { messages: unknown[]; documents?: unknown[] },
  signal?: AbortSignal,
): Promise<Response> {
  const res = await fetch(`/api/agents/${name}/predict`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  await assertOk(res);
  return res;
}

export async function streamAgent(
  name: string,
  messages: unknown[],
  signal?: AbortSignal,
  documents?: unknown[],
): Promise<Response> {
  const res = await fetch(`/api/agents/${name}/agent`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ messages, documents }),
    signal,
  });
  await assertOk(res);
  return res;
}

export type { ActorUsageView };

/** Who spent this agent's budget. Owner/admin only, like traces. */
export async function usageActors(
  name: string,
  from: string,
  to: string,
): Promise<AgentActorUsage> {
  return readJson<AgentActorUsage>(
    await fetch(`/api/agents/${name}/usage/actors?from=${from}&to=${to}`),
  );
}

export type { AgentSlackResponse };

export async function getAgentSlack(name: string): Promise<AgentSlackResponse> {
  return readJson<AgentSlackResponse>(await fetch(`/api/agents/${name}/slack`));
}

export async function updateAgentSlack(
  name: string,
  update: {
    botToken?: string;
    signingSecret?: string;
    enabled?: boolean;
    suggestedPrompts?: SlackSuggestedPrompt[];
    channelKeywords?: string[];
  },
): Promise<AgentSlackResponse> {
  return readJson<AgentSlackResponse>(
    await fetch(`/api/agents/${name}/slack`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify(update),
    }),
  );
}

export async function disconnectAgentSlack(name: string): Promise<void> {
  await assertOk(await fetch(`/api/agents/${name}/slack`, { method: "DELETE" }));
}

export async function testAgentSlack(
  name: string,
): Promise<{ ok: true; team?: string; botUser?: string }> {
  const res = await fetch(`/api/agents/${name}/slack/test`, { method: "POST" });
  return readJson<{ ok: true; team?: string; botUser?: string }>(res);
}

export async function listAgentSlackChannels(
  name: string,
): Promise<{ channels: SlackChannelInfo[] }> {
  return readJson<{ channels: SlackChannelInfo[] }>(
    await fetch(`/api/agents/${name}/slack/channels`),
  );
}

export type { AgentTelegramResponse };

export async function getAgentTelegram(name: string): Promise<AgentTelegramResponse> {
  return readJson<AgentTelegramResponse>(await fetch(`/api/agents/${name}/telegram`));
}

export type { TelegramDestination };

export async function listAgentTelegramChats(
  name: string,
): Promise<{ chats: TelegramDestination[] }> {
  return readJson<{ chats: TelegramDestination[] }>(
    await fetch(`/api/agents/${name}/telegram/chats`),
  );
}

export async function updateAgentTelegram(
  name: string,
  update: { botToken?: string; enabled?: boolean },
): Promise<AgentTelegramResponse> {
  return readJson<AgentTelegramResponse>(
    await fetch(`/api/agents/${name}/telegram`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify(update),
    }),
  );
}

export async function disconnectAgentTelegram(name: string): Promise<void> {
  await assertOk(await fetch(`/api/agents/${name}/telegram`, { method: "DELETE" }));
}

/** Throws with the server's reason when the test could not run; a failed test itself is the body. */
export async function testAgentTelegram(
  name: string,
): Promise<{ ok: true; botId: number; botUsername?: string }> {
  return readJson(await fetch(`/api/agents/${name}/telegram/test`, { method: "POST" }));
}

/** Register (or move) the bot's webhook to this deployment. */
export async function registerAgentTelegramWebhook(name: string): Promise<{ ok: true; url: string }> {
  return readJson(await fetch(`/api/agents/${name}/telegram/webhook`, { method: "POST" }));
}

export type { AgentTeamsResponse };

export async function getAgentTeams(name: string): Promise<AgentTeamsResponse> {
  return readJson<AgentTeamsResponse>(await fetch(`/api/agents/${name}/teams`));
}

export async function updateAgentTeams(
  name: string,
  update: { appId?: string; appPassword?: string; tenantId?: string; enabled?: boolean },
): Promise<AgentTeamsResponse> {
  return readJson<AgentTeamsResponse>(
    await fetch(`/api/agents/${name}/teams`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify(update),
    }),
  );
}

export async function disconnectAgentTeams(name: string): Promise<void> {
  await assertOk(await fetch(`/api/agents/${name}/teams`, { method: "DELETE" }));
}

/** Throws with the server's reason when the test could not run. */
export async function testAgentTeams(
  name: string,
): Promise<{ ok: true; appId: string; expiresInSeconds: number }> {
  return readJson(await fetch(`/api/agents/${name}/teams/test`, { method: "POST" }));
}

export type { ApiTokenStatus };

export async function getAgentToken(name: string): Promise<ApiTokenStatus> {
  return readJson<ApiTokenStatus>(await fetch(`/api/agents/${name}/token`));
}

/** Generate (or regenerate) the agent API token. Returns the raw token once. */
export async function generateAgentToken(
  name: string,
): Promise<{ token: string; masked: string; createdAt: string }> {
  const data = await readJson<{
    token?: string;
    masked?: string;
    createdAt?: string;
  }>(await fetch(`/api/agents/${name}/token`, { method: "POST" }));
  if (!data.token) {
    throw new Error("Agent API token response did not include a token");
  }
  return { token: data.token, masked: data.masked ?? "", createdAt: data.createdAt ?? "" };
}

/**
 * Read the stored token back in plaintext (owner or admin). A POST, not a GET: the
 * response body is a live credential and must stay out of caches and history.
 */
export async function revealAgentToken(name: string): Promise<string> {
  const data = await readJson<{ token?: string }>(
    await fetch(`/api/agents/${name}/token/reveal`, { method: "POST" }),
  );
  if (!data.token) {
    throw new Error("Agent API token response did not include a token");
  }
  return data.token;
}

export async function revokeAgentToken(name: string): Promise<void> {
  await assertOk(await fetch(`/api/agents/${name}/token`, { method: "DELETE" }));
}


// --- MCP OAuth connections -------------------------------------------------

/**
 * An agent's connection to an OAuth-required registry server. Carries no
 * secret and no token — there is no reveal path for either, so this is the whole
 * of what the console can know.
 */
export type { McpConnectionView };

export function listMcpConnections(name: string): Promise<McpConnectionView[]> {
  return fetch(`/api/agents/${name}/mcp-connections`)
    .then((r) => readJson<{ connections: McpConnectionView[] }>(r))
    .then((data) => data.connections);
}

export function saveMcpClientCredentials(
  name: string,
  server: string,
  input: { clientId: string; clientSecret?: string; scopes?: string[] },
): Promise<McpConnectionView> {
  return fetch(`/api/agents/${name}/mcp-connections/${server}`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }).then((r) => readJson<McpConnectionView>(r));
}

/** Returns the provider URL to open; the callback finishes the flow. */
export function beginMcpAuthorization(name: string, server: string): Promise<string> {
  return fetch(`/api/agents/${name}/mcp-connections/${server}/authorize`, { method: "POST" })
    .then((r) => readJson<{ authorizeUrl: string }>(r))
    .then((data) => data.authorizeUrl);
}

export async function disconnectMcp(name: string, server: string): Promise<void> {
  await assertOk(
    await fetch(`/api/agents/${name}/mcp-connections/${server}`, { method: "DELETE" }),
  );
}

/**
 * A server's tools as this agent sees them — the registry entry's headers, the
 * binding's overrides, and the agent's OAuth token. The registry-level probe
 * cannot answer for an OAuth server, since the credential belongs here.
 *
 * Only the owner may spend that credential, and agents are a shared catalog
 * anyone may read, so a non-owner falls back to the registry probe: no agent
 * credential and no overrides, but a tool list rather than a permission error.
 */
export async function listAgentMcpTools(
  name: string,
  server: string,
  headerOverrides?: Record<string, string | null>,
): Promise<McpTool[]> {
  const response = await fetch(`/api/agents/${name}/mcp-connections/${server}/tools`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ headerOverrides }),
  });
  if (response.status === 403) {
    return testMcpConnection(server);
  }
  return (await readJson<{ tools: McpTool[] }>(response)).tools;
}

// --- Triggers --------------------------------------------------------------

export type { TriggerRun, WebhookTrigger } from "@/domain/trigger/types";

// The server's own view and input types, re-exported type-only so the client
// cannot drift from what the API actually accepts and returns.
export type {
  CreateTriggerInput,
  TriggerView,
  UpdateTriggerInput,
} from "@/application/trigger/triggerUseCases";
import type {
  CreateTriggerInput,
  TriggerView,
  UpdateTriggerInput,
} from "@/application/trigger/triggerUseCases";

export function listTriggers(name: string): Promise<{ triggers: TriggerView[] }> {
  return fetch(`/api/agents/${name}/triggers`).then((r) =>
    readJson<{ triggers: TriggerView[] }>(r),
  );
}

export function createTrigger(name: string, input: CreateTriggerInput): Promise<TriggerView> {
  return fetch(`/api/agents/${name}/triggers`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }).then((r) => readJson<TriggerView>(r));
}

export function updateTrigger(
  name: string,
  triggerId: string,
  input: UpdateTriggerInput,
): Promise<TriggerView> {
  return fetch(`/api/agents/${name}/triggers/${triggerId}`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }).then((r) => readJson<TriggerView>(r));
}

export function deleteTrigger(name: string, triggerId: string): Promise<void> {
  return fetch(`/api/agents/${name}/triggers/${triggerId}`, { method: "DELETE" }).then(assertOk);
}

/** Read a trigger's secret back. POST, not GET — the body is a live credential. */
export function revealTriggerSecret(name: string, triggerId: string): Promise<string> {
  return fetch(`/api/agents/${name}/triggers/${triggerId}/reveal`, { method: "POST" })
    .then((r) => readJson<{ secret: string }>(r))
    .then((d) => d.secret);
}

export function listTriggerRuns(
  name: string,
  triggerId: string,
): Promise<{ runs: import("@/domain/trigger/types").TriggerRun[] }> {
  return fetch(`/api/agents/${name}/triggers/${triggerId}/runs`).then((r) =>
    readJson<{ runs: import("@/domain/trigger/types").TriggerRun[] }>(r),
  );
}
