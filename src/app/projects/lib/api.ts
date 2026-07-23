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

export type { Project, ProjectType, SubagentRef, Version, VersionParameters };
export type { ModelConfig, EngineChunk, UsageRow };

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

async function assertOk(res: Response): Promise<void> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
}

const jsonHeaders = { "Content-Type": "application/json" } as const;

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
  input: Partial<VersionInput>,
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

/** Parse an SSE response body into engine chunks. Frames are `data: {json}\n\n`, terminated by `[DONE]`. */
export async function* readSse(response: Response): AsyncGenerator<EngineChunk> {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (frame.startsWith("data:")) {
        const data = frame.slice(5).trim();
        if (data === "[DONE]") {
          return;
        }
        try {
          yield JSON.parse(data) as EngineChunk;
        } catch {
          // Ignore malformed frames.
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
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

export interface ProjectA2aView {
  enabled: boolean;
  published: boolean;
  cardUrl: string | null;
}

export async function getProjectA2a(name: string): Promise<ProjectA2aView> {
  const res = await fetch(`/api/projects/${name}/a2a`);
  if (!res.ok) {
    throw new Error(`Failed to load A2A settings (${res.status})`);
  }
  return (await res.json()) as ProjectA2aView;
}
