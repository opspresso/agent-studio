import type {
  Project,
  ProjectType,
  SubagentRef,
  Version,
  VersionParameters,
} from "@/domain/project/types";
import type { ModelConfig } from "@/domain/llm/models";
import type { EngineChunk } from "@/domain/llm/types";
import type { UsageRow } from "@/domain/usage/types";
import type { Trace } from "@/domain/trace/types";
import { assertOk, jsonHeaders, readJson } from "@/app/_lib/httpClient";
import { readSse as readSseFrames } from "@/app/_lib/sse";

export type { Project, ProjectType, SubagentRef, Version, VersionParameters };
export type { ModelConfig, EngineChunk, UsageRow, Trace };

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

export function listTraces(name: string): Promise<{ traces: Trace[] }> {
  return fetch(`/api/projects/${name}/traces`).then((r) => readJson<{ traces: Trace[] }>(r));
}

// --- Versions -------------------------------------------------------------

export interface VersionInput {
  systemPrompt: string;
  userPromptTemplate: string;
  model: string;
  fallbackModel?: string;
  parameters: VersionParameters;
  mcpList: string[];
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

export interface ImageResult {
  imageBase64: string;
  mimeType: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

export async function predictImage(
  name: string,
  version: string,
  body: { prompt: string; size?: string; quality?: string },
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

export interface ProjectSlackView {
  enabled: boolean;
  configured: boolean;
  botToken: string;
  signingSecret: string;
  eventsPath: string;
  eventsUrl: string;
  manifest?: Record<string, unknown>;
}

export async function getProjectSlack(name: string): Promise<ProjectSlackView> {
  const res = await fetch(`/api/projects/${name}/slack`);
  if (!res.ok) {
    throw new Error(`Failed to load Slack settings (${res.status})`);
  }
  return (await res.json()) as ProjectSlackView;
}

export async function updateProjectSlack(
  name: string,
  update: { botToken?: string; signingSecret?: string; enabled?: boolean },
): Promise<ProjectSlackView> {
  const res = await fetch(`/api/projects/${name}/slack`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  const data = (await res.json()) as ProjectSlackView & { error?: string };
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

export interface ProjectTokenStatus {
  configured: boolean;
  createdAt?: string;
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
): Promise<{ token: string; createdAt: string }> {
  const res = await fetch(`/api/projects/${name}/token`, { method: "POST" });
  const data = (await res.json()) as { token?: string; createdAt?: string; error?: string };
  if (!res.ok || !data.token) {
    throw new Error(data.error ?? `Failed to generate token (${res.status})`);
  }
  return { token: data.token, createdAt: data.createdAt ?? "" };
}

export async function revokeProjectToken(name: string): Promise<void> {
  const res = await fetch(`/api/projects/${name}/token`, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`Failed to revoke token (${res.status})`);
  }
}

export interface ProjectA2aView {
  enabled: boolean;
  published: boolean;
  cardUrl: string | null;
  card: Record<string, unknown> | null;
}

export async function getProjectA2a(name: string): Promise<ProjectA2aView> {
  const res = await fetch(`/api/projects/${name}/a2a`);
  if (!res.ok) {
    throw new Error(`Failed to load A2A settings (${res.status})`);
  }
  return (await res.json()) as ProjectA2aView;
}
