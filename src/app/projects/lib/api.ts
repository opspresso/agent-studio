import type {
  CostLimits,
  McpBinding,
  Project,
  ProjectType,
  SubagentRef,
  Version,
  VersionParameters,
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
import type { ActorUsageView } from "@/application/usage/listActors";
import type { ProjectA2aView } from "@/app/api/projects/[name]/a2a/route";
import type { ProjectSlackResponse } from "@/app/api/projects/[name]/slack/route";
import type { ProjectTelegramResponse } from "@/app/api/projects/[name]/telegram/route";
import type { ProjectTeamsResponse } from "@/app/api/projects/[name]/teams/route";
import type { PromptPreview } from "@/application/execution/deps";
import type { GenerateImageOutput } from "@/application/image/generateImage";
import { assertOk, jsonHeaders, readJson } from "@/app/_lib/httpClient";
import { testMcpConnection } from "@/app/tools/api";
import { readSse as readSseFrames } from "@/app/_lib/sse";

export type { CostLimits, McpBinding, Project, ProjectType, SubagentRef, Version, VersionParameters };
export type { ModelConfig, EngineChunk, UsageRow, Trace, SlackChannelInfo, SlackSuggestedPrompt };

// --- Projects -------------------------------------------------------------

export interface CreateProjectInput {
  name: string;
  displayName: string;
  description: string;
  projectType: ProjectType;
  departmentCode?: string;
}

export interface UpdateProjectInput {
  displayName?: string;
  description?: string;
  departmentCode?: string;
  /** Sent whole; `null` removes the guards. Omitted leaves them untouched. */
  costLimits?: CostLimits | null;
}

export function listProjects(): Promise<Project[]> {
  return fetch("/api/projects").then((r) => readJson<Project[]>(r));
}

export function getProject(name: string): Promise<Project> {
  return fetch(`/api/projects/${name}`).then((r) => readJson<Project>(r));
}

export function createProject(input: CreateProjectInput): Promise<Project> {
  return fetch("/api/projects", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }).then((r) => readJson<Project>(r));
}

export function updateProject(name: string, patch: UpdateProjectInput): Promise<Project> {
  return fetch(`/api/projects/${name}`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(patch),
  }).then((r) => readJson<Project>(r));
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

// --- Versions -------------------------------------------------------------

export interface VersionInput {
  systemPrompt: string;
  userPromptTemplate: string;
  model: string;
  fallbackModel?: string;
  parameters: VersionParameters;
  mcpList: McpBinding[];
  skillList: string[];
  subagentList: SubagentRef[];
  maxTurn?: number;
}

export type UpdateVersionInput = Partial<Omit<VersionInput, "fallbackModel" | "maxTurn">> & {
  fallbackModel?: string | null;
  maxTurn?: number | null;
};

export function listVersions(name: string): Promise<Version[]> {
  return fetch(`/api/projects/${name}/versions`).then((r) => readJson<Version[]>(r));
}

export function getVersion(name: string, version: string): Promise<Version> {
  return fetch(`/api/projects/${name}/versions/${version}`).then((r) => readJson<Version>(r));
}

export function createVersion(
  name: string,
  input: VersionInput & { versionName?: string },
): Promise<Version> {
  return fetch(`/api/projects/${name}/versions`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }).then((r) => readJson<Version>(r));
}

export function updateVersion(
  name: string,
  version: string,
  input: UpdateVersionInput,
): Promise<Version> {
  return fetch(`/api/projects/${name}/versions/${version}`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }).then((r) => readJson<Version>(r));
}

export type { PromptPreview };

/**
 * Assemble what the draft in the editor would send. Owner or admin, and it contacts
 * the bound MCP servers, so the panel calls it on demand rather than as the
 * editor changes.
 *
 * `versionName` names the saved version the draft started from, not the draft
 * itself. The editor reads header overrides masked and hands them back that
 * way, so the server needs it to resolve them into the secrets a run would
 * actually send; omit it for a version that has never been saved.
 */
export function previewPrompt(
  name: string,
  input: VersionInput & {
    versionName?: string;
    variables?: Record<string, string>;
    /** A request to preview against; only capability discovery reads it. */
    message?: string;
  },
): Promise<PromptPreview> {
  return fetch(`/api/projects/${name}/preview`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }).then((r) => readJson<PromptPreview>(r));
}

export function deleteVersion(name: string, version: string): Promise<void> {
  return fetch(`/api/projects/${name}/versions/${version}`, { method: "DELETE" }).then(assertOk);
}

export function publishVersion(name: string, versionName: string): Promise<Project> {
  return fetch(`/api/projects/${name}/publish`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ versionName }),
  }).then((r) => readJson<Project>(r));
}

// --- Models ---------------------------------------------------------------

/** Fetch the model registry. Returns [] if the endpoint is unavailable. */
export async function listModels(): Promise<ModelConfig[]> {
  try {
    const res = await fetch("/api/models");
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as { models?: ModelConfig[] };
    return data.models ?? [];
  } catch {
    return [];
  }
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
  version: string,
  body: { variables?: Record<string, string>; messages?: unknown[] },
): Promise<Response> {
  const res = await fetch(`/api/projects/${name}/versions/${version}/predict`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ ...body, stream: true }),
  });
  await assertOk(res);
  return res;
}

export async function streamAgent(
  name: string,
  version: string,
  messages: unknown[],
): Promise<Response> {
  const res = await fetch(`/api/projects/${name}/versions/${version}/agent`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ messages }),
  });
  await assertOk(res);
  return res;
}

/** What `POST /predict` answers with for an image project, as the use case built it. */
export type ImageResult = GenerateImageOutput;

export async function predictImage(
  name: string,
  version: string,
  body: {
    prompt: string;
    size?: string;
    quality?: string;
    /** Source images to edit; omit to generate from the prompt alone. */
    images?: Array<{ b64: string; mimeType: string }>;
  },
): Promise<ImageResult> {
  const res = await fetch(`/api/projects/${name}/versions/${version}/predict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Image generation failed (${res.status})`);
  }
  return (await res.json()) as ImageResult;
}

export type { ActorUsageView };

/** Who spent this project's budget. Owner/admin only, like traces. */
export async function usageActors(
  name: string,
  from: string,
  to: string,
): Promise<{ items: ActorUsageView[] }> {
  const res = await fetch(`/api/projects/${name}/usage/actors?from=${from}&to=${to}`);
  await assertOk(res);
  return (await res.json()) as { items: ActorUsageView[] };
}

export type { ProjectSlackResponse };

export async function getProjectSlack(name: string): Promise<ProjectSlackResponse> {
  const res = await fetch(`/api/projects/${name}/slack`);
  if (!res.ok) {
    throw new Error(`Failed to load Slack settings (${res.status})`);
  }
  return (await res.json()) as ProjectSlackResponse;
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
  const res = await fetch(`/api/projects/${name}/slack`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  const data = (await res.json()) as ProjectSlackResponse & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `Failed to save Slack settings (${res.status})`);
  }
  return data;
}

export async function disconnectProjectSlack(name: string): Promise<void> {
  const res = await fetch(`/api/projects/${name}/slack`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`Failed to disconnect Slack (${res.status})`);
  }
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

export interface TelegramDestinationInfo {
  chatId: number;
  chatType: "private" | "group" | "supergroup" | "channel";
  title: string;
  threadId?: number;
  lastSeenAt: string;
}

export async function listProjectTelegramChats(
  name: string,
): Promise<{ chats: TelegramDestinationInfo[] }> {
  return readJson<{ chats: TelegramDestinationInfo[] }>(
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

export interface ProjectTokenStatus {
  configured: boolean;
  /** Display mask of the stored token; absent on tokens issued before masks. */
  masked?: string;
  createdAt?: string;
  /** False for a legacy hashed token, which can only be replaced. */
  revealable?: boolean;
}

export async function getProjectToken(name: string): Promise<ProjectTokenStatus> {
  const res = await fetch(`/api/projects/${name}/token`);
  if (!res.ok) {
    throw new Error(`Failed to load API token status (${res.status})`);
  }
  return (await res.json()) as ProjectTokenStatus;
}

/** Generate (or regenerate) the project API token. Returns the raw token once. */
export async function generateProjectToken(
  name: string,
): Promise<{ token: string; masked: string; createdAt: string }> {
  const res = await fetch(`/api/projects/${name}/token`, { method: "POST" });
  const data = (await res.json()) as {
    token?: string;
    masked?: string;
    createdAt?: string;
    error?: string;
  };
  if (!res.ok || !data.token) {
    throw new Error(data.error ?? `Failed to generate token (${res.status})`);
  }
  return { token: data.token, masked: data.masked ?? "", createdAt: data.createdAt ?? "" };
}

/**
 * Read the stored token back in plaintext (owner or admin). A POST, not a GET: the
 * response body is a live credential and must stay out of caches and history.
 */
export async function revealProjectToken(name: string): Promise<string> {
  const res = await fetch(`/api/projects/${name}/token/reveal`, { method: "POST" });
  const data = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!res.ok || !data.token) {
    throw new Error(data.error ?? `Failed to reveal token (${res.status})`);
  }
  return data.token;
}

export async function revokeProjectToken(name: string): Promise<void> {
  const res = await fetch(`/api/projects/${name}/token`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`Failed to revoke token (${res.status})`);
  }
}

export type { ProjectA2aView };

export async function getProjectA2a(name: string): Promise<ProjectA2aView> {
  const res = await fetch(`/api/projects/${name}/a2a`);
  if (!res.ok) {
    throw new Error(`Failed to load A2A settings (${res.status})`);
  }
  return (await res.json()) as ProjectA2aView;
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
    body: JSON.stringify(headerOverrides ? { headerOverrides } : {}),
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
