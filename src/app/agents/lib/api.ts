import { notifyConfigurationChange } from "./configurationEvents";
import type {
  CostLimits,
  McpBinding,
  Project,
  ProjectVisibility,
  SubagentRef,
  AgentConfiguration,
  AgentParameters,
} from "@/domain/project/types";
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
import type { ActorUsageView, ProjectActorUsage } from "@/application/usage/listActors";
import type { CloneProjectResponse } from "@/app/api/projects/[name]/clone/route";
import type { ModelsResponse } from "@/app/api/models/route";
import type { SanitizedProject } from "@/app/api/projects/_lib/http";
import type { ProjectSlackResponse } from "@/app/api/projects/[name]/slack/route";
import type { ProjectTelegramResponse } from "@/app/api/projects/[name]/telegram/route";
import type { ProjectTeamsResponse } from "@/app/api/projects/[name]/teams/route";
import type { PromptPreview } from "@/application/execution/deps";
import type { ApiTokenStatus } from "@/application/project/apiTokenUseCases";
import type {
  AgentConfigurationView,
  AgentConfigurationInput,
  PutAgentConfigurationInput,
} from "@/application/project/configurationUseCases";
import type { TelegramDestination } from "@/domain/telegram/destination";
import { assertOk, jsonHeaders, readJson } from "@/app/_lib/httpClient";
import { testMcpConnection } from "@/app/tools/api";
import { readSse as readSseFrames } from "@/app/_lib/sse";

export type { CostLimits, McpBinding, Project, ProjectVisibility, SubagentRef, AgentConfiguration, AgentParameters };
export type { ModelConfig, EngineChunk, UsageRow, Trace, SlackChannelInfo, SlackSuggestedPrompt };
export type SelectableModel = ModelsResponse["models"][number];

// --- Projects -------------------------------------------------------------

export interface CreateProjectInput {
  name: string;
  displayName: string;
  description: string;
  departmentCode?: string;
}

export interface UpdateProjectInput {
  displayName?: string;
  description?: string;
  departmentCode?: string;
  /** Sent whole; `null` removes the guards. Omitted leaves them untouched. */
  costLimits?: CostLimits | null;
  visibility?: ProjectVisibility;
  /** Sent whole; replaces the invite list. Omitted leaves it untouched. */
  memberEmails?: string[];
}

// Project responses are the sanitized shape the routes actually build —
// integrations arrive as summaries, which is what lets a page ask "is Slack
// connected" before it fires a request only a connected bot can answer.
export type { SanitizedProject };

export function listProjects(): Promise<SanitizedProject[]> {
  return fetch("/api/projects").then((r) => readJson<SanitizedProject[]>(r));
}

export function getProject(name: string): Promise<SanitizedProject> {
  return fetch(`/api/projects/${name}`).then((r) => readJson<SanitizedProject>(r));
}

export function createProject(input: CreateProjectInput): Promise<SanitizedProject> {
  return fetch("/api/projects", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }).then((r) => readJson<SanitizedProject>(r));
}

export function updateProject(name: string, patch: UpdateProjectInput): Promise<SanitizedProject> {
  return fetch(`/api/projects/${name}`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(patch),
  }).then((r) => readJson<SanitizedProject>(r));
}

export function cloneProject(
  sourceName: string,
  input: { name: string; displayName: string },
): Promise<CloneProjectResponse> {
  return fetch(`/api/projects/${sourceName}/clone`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }).then((r) => readJson<CloneProjectResponse>(r));
}

export function deleteProject(name: string): Promise<void> {
  return fetch(`/api/projects/${name}`, { method: "DELETE" }).then(assertOk);
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
  return fetch(`/api/projects/${name}/traces${qs ? `?${qs}` : ""}`).then((r) =>
    readJson<{ traces: Trace[] }>(r),
  );
}

export function getTrace(name: string, traceId: string): Promise<Trace> {
  return fetch(`/api/projects/${name}/traces/${traceId}`).then((r) => readJson<Trace>(r));
}

// --- Current Agent settings ------------------------------------------------

export type { AgentConfigurationInput, AgentConfigurationView, PutAgentConfigurationInput, PromptPreview };

export function getConfiguration(name: string): Promise<AgentConfigurationView> {
  return fetch(`/api/projects/${name}/configuration`).then(r => readJson<AgentConfigurationView>(r));
}

export function putConfiguration(name: string, input: PutAgentConfigurationInput): Promise<AgentConfigurationView> {
  return fetch(`/api/projects/${name}/configuration`, { method: "PUT", headers: jsonHeaders,
    body: JSON.stringify(input) }).then(r => readJson<AgentConfigurationView>(r)).then(saved => {
      notifyConfigurationChange(name);
      return saved;
    });
}

export function previewPrompt(name: string, input: AgentConfigurationInput & { message?: string }, signal?: AbortSignal): Promise<PromptPreview> {
  return fetch(`/api/projects/${name}/preview`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(input), signal })
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
  const query = new URLSearchParams({ project: name, from, to });
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
  const res = await fetch(`/api/projects/${name}/predict`, {
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
  const res = await fetch(`/api/projects/${name}/agent`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ messages, documents }),
    signal,
  });
  await assertOk(res);
  return res;
}

export type { ActorUsageView };

/** Who spent this project's budget. Owner/admin only, like traces. */
export async function usageActors(
  name: string,
  from: string,
  to: string,
): Promise<ProjectActorUsage> {
  return readJson<ProjectActorUsage>(
    await fetch(`/api/projects/${name}/usage/actors?from=${from}&to=${to}`),
  );
}

export type { ProjectSlackResponse };

export async function getProjectSlack(name: string): Promise<ProjectSlackResponse> {
  return readJson<ProjectSlackResponse>(await fetch(`/api/projects/${name}/slack`));
}

export async function updateProjectSlack(
  name: string,
  update: {
    botToken?: string;
    signingSecret?: string;
    enabled?: boolean;
    suggestedPrompts?: SlackSuggestedPrompt[];
    channelKeywords?: string[];
  },
): Promise<ProjectSlackResponse> {
  return readJson<ProjectSlackResponse>(
    await fetch(`/api/projects/${name}/slack`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify(update),
    }),
  );
}

export async function disconnectProjectSlack(name: string): Promise<void> {
  await assertOk(await fetch(`/api/projects/${name}/slack`, { method: "DELETE" }));
}

export async function testProjectSlack(
  name: string,
): Promise<{ ok?: boolean; team?: string; botUser?: string; error?: string }> {
  const res = await fetch(`/api/projects/${name}/slack/test`, { method: "POST" });
  return (await res.json()) as { ok?: boolean; team?: string; botUser?: string; error?: string };
}

export async function listProjectSlackChannels(
  name: string,
): Promise<{ channels: SlackChannelInfo[] }> {
  return readJson<{ channels: SlackChannelInfo[] }>(
    await fetch(`/api/projects/${name}/slack/channels`),
  );
}

export type { ProjectTelegramResponse };

export async function getProjectTelegram(name: string): Promise<ProjectTelegramResponse> {
  return readJson<ProjectTelegramResponse>(await fetch(`/api/projects/${name}/telegram`));
}

export type { TelegramDestination };

export async function listProjectTelegramChats(
  name: string,
): Promise<{ chats: TelegramDestination[] }> {
  return readJson<{ chats: TelegramDestination[] }>(
    await fetch(`/api/projects/${name}/telegram/chats`),
  );
}

export async function updateProjectTelegram(
  name: string,
  update: { botToken?: string; enabled?: boolean },
): Promise<ProjectTelegramResponse> {
  return readJson<ProjectTelegramResponse>(
    await fetch(`/api/projects/${name}/telegram`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify(update),
    }),
  );
}

export async function disconnectProjectTelegram(name: string): Promise<void> {
  await assertOk(await fetch(`/api/projects/${name}/telegram`, { method: "DELETE" }));
}

/** Throws with the server's reason when the test could not run; a failed test itself is the body. */
export async function testProjectTelegram(
  name: string,
): Promise<{ ok: true; botId: number; botUsername?: string }> {
  return readJson(await fetch(`/api/projects/${name}/telegram/test`, { method: "POST" }));
}

/** Register (or move) the bot's webhook to this deployment. */
export async function registerProjectTelegramWebhook(name: string): Promise<{ ok: true; url: string }> {
  return readJson(await fetch(`/api/projects/${name}/telegram/webhook`, { method: "POST" }));
}

export type { ProjectTeamsResponse };

export async function getProjectTeams(name: string): Promise<ProjectTeamsResponse> {
  return readJson<ProjectTeamsResponse>(await fetch(`/api/projects/${name}/teams`));
}

export async function updateProjectTeams(
  name: string,
  update: { appId?: string; appPassword?: string; tenantId?: string; enabled?: boolean },
): Promise<ProjectTeamsResponse> {
  return readJson<ProjectTeamsResponse>(
    await fetch(`/api/projects/${name}/teams`, {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify(update),
    }),
  );
}

export async function disconnectProjectTeams(name: string): Promise<void> {
  await assertOk(await fetch(`/api/projects/${name}/teams`, { method: "DELETE" }));
}

/** Throws with the server's reason when the test could not run. */
export async function testProjectTeams(
  name: string,
): Promise<{ ok: true; appId: string; expiresInSeconds: number }> {
  return readJson(await fetch(`/api/projects/${name}/teams/test`, { method: "POST" }));
}

export type { ApiTokenStatus };

export async function getProjectToken(name: string): Promise<ApiTokenStatus> {
  return readJson<ApiTokenStatus>(await fetch(`/api/projects/${name}/token`));
}

/** Generate (or regenerate) the project API token. Returns the raw token once. */
export async function generateProjectToken(
  name: string,
): Promise<{ token: string; masked: string; createdAt: string }> {
  const data = await readJson<{
    token?: string;
    masked?: string;
    createdAt?: string;
  }>(await fetch(`/api/projects/${name}/token`, { method: "POST" }));
  if (!data.token) {
    throw new Error("Agent API token response did not include a token");
  }
  return { token: data.token, masked: data.masked ?? "", createdAt: data.createdAt ?? "" };
}

/**
 * Read the stored token back in plaintext (owner or admin). A POST, not a GET: the
 * response body is a live credential and must stay out of caches and history.
 */
export async function revealProjectToken(name: string): Promise<string> {
  const data = await readJson<{ token?: string }>(
    await fetch(`/api/projects/${name}/token/reveal`, { method: "POST" }),
  );
  if (!data.token) {
    throw new Error("Agent API token response did not include a token");
  }
  return data.token;
}

export async function revokeProjectToken(name: string): Promise<void> {
  await assertOk(await fetch(`/api/projects/${name}/token`, { method: "DELETE" }));
}


// --- MCP OAuth connections -------------------------------------------------

/**
 * A project's connection to an OAuth-required registry server. Carries no
 * secret and no token — there is no reveal path for either, so this is the whole
 * of what the console can know.
 */
export type { McpConnectionView };

export function listMcpConnections(name: string): Promise<McpConnectionView[]> {
  return fetch(`/api/projects/${name}/mcp-connections`)
    .then((r) => readJson<{ connections: McpConnectionView[] }>(r))
    .then((data) => data.connections);
}

export function saveMcpClientCredentials(
  name: string,
  server: string,
  input: { clientId: string; clientSecret?: string; scopes?: string[] },
): Promise<McpConnectionView> {
  return fetch(`/api/projects/${name}/mcp-connections/${server}`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }).then((r) => readJson<McpConnectionView>(r));
}

/** Returns the provider URL to open; the callback finishes the flow. */
export function beginMcpAuthorization(name: string, server: string): Promise<string> {
  return fetch(`/api/projects/${name}/mcp-connections/${server}/authorize`, { method: "POST" })
    .then((r) => readJson<{ authorizeUrl: string }>(r))
    .then((data) => data.authorizeUrl);
}

export async function disconnectMcp(name: string, server: string): Promise<void> {
  await assertOk(
    await fetch(`/api/projects/${name}/mcp-connections/${server}`, { method: "DELETE" }),
  );
}

/**
 * A server's tools as this project sees them — the registry entry's headers, the
 * binding's overrides, and the project's OAuth token. The registry-level probe
 * cannot answer for an OAuth server, since the credential belongs here.
 *
 * Only the owner may spend that credential, and projects are a shared catalog
 * anyone may read, so a non-owner falls back to the registry probe: no project
 * credential and no overrides, but a tool list rather than a permission error.
 */
export async function listProjectMcpTools(
  name: string,
  server: string,
  headerOverrides?: Record<string, string | null>,
): Promise<McpTool[]> {
  const response = await fetch(`/api/projects/${name}/mcp-connections/${server}/tools`, {
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
  return fetch(`/api/projects/${name}/triggers`).then((r) =>
    readJson<{ triggers: TriggerView[] }>(r),
  );
}

export function createTrigger(name: string, input: CreateTriggerInput): Promise<TriggerView> {
  return fetch(`/api/projects/${name}/triggers`, {
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
  return fetch(`/api/projects/${name}/triggers/${triggerId}`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }).then((r) => readJson<TriggerView>(r));
}

export function deleteTrigger(name: string, triggerId: string): Promise<void> {
  return fetch(`/api/projects/${name}/triggers/${triggerId}`, { method: "DELETE" }).then(assertOk);
}

/** Read a trigger's secret back. POST, not GET — the body is a live credential. */
export function revealTriggerSecret(name: string, triggerId: string): Promise<string> {
  return fetch(`/api/projects/${name}/triggers/${triggerId}/reveal`, { method: "POST" })
    .then((r) => readJson<{ secret: string }>(r))
    .then((d) => d.secret);
}

export function listTriggerRuns(
  name: string,
  triggerId: string,
): Promise<{ runs: import("@/domain/trigger/types").TriggerRun[] }> {
  return fetch(`/api/projects/${name}/triggers/${triggerId}/runs`).then((r) =>
    readJson<{ runs: import("@/domain/trigger/types").TriggerRun[] }>(r),
  );
}
