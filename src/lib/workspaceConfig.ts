import { z } from "zod";
import { WORKSPACE_RUNTIMES } from "@/domain/workspace/types";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";
import { isRepositoryName } from "@/domain/workspace/policy";

const runtime = z.enum(WORKSPACE_RUNTIMES);
const runtimeSettings = z.object({
  model: z.string().min(1).max(200).optional(),
  environment: z.partialRecord(z.enum(["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "OPENCODE_CONFIG_CONTENT"]),
    z.string().max(32_000).refine(value => !value.includes("\0"))).optional(),
}).strict();
const workspaceConfig = z.object({
  image: z.string().min(1).max(300),
  network: z.string().min(1).max(100).default("none"),
  context: z.string().min(1).max(100).optional(),
  memoryMb: z.number().int().min(128).max(65536).default(2048),
  diskMb: z.number().int().min(64).max(65536).default(2048),
  cpus: z.number().min(0.1).max(64).default(2),
  idleTtlSeconds: z.number().int().min(WORKSPACE_LIMITS.minIdleTtlSeconds).max(WORKSPACE_LIMITS.maxIdleTtlSeconds).default(1800),
  projects: z.array(z.object({
    projectName: z.string().min(1).max(100),
    runtimes: z.array(runtime).min(1).max(WORKSPACE_RUNTIMES.length),
    repository: z.string().refine(isRepositoryName).optional(),
    checks: z.array(z.object({ name: z.enum(["test", "lint", "build"]), command: z.string().min(1).max(4000) }).strict()).max(3).default([]),
    deploymentWorkflows: z.array(z.string().min(1).max(200)).max(20).default([]),
  }).strict()).max(200),
  runtimes: z.partialRecord(runtime, runtimeSettings).default({}),
}).strict();

export type WorkspaceConfig = z.infer<typeof workspaceConfig>;

/** Deployment-owned configuration; parse errors never echo embedded model credentials. */
export function parseWorkspaceConfig(raw: string | undefined): WorkspaceConfig | undefined {
  if (!raw?.trim()) return undefined;
  if (Buffer.byteLength(raw) > 256_000) throw new Error("WORKSPACE_CONFIG exceeds its byte limit");
  try {
    const config = workspaceConfig.parse(JSON.parse(raw));
    if (new Set(config.projects.map(project => project.projectName)).size !== config.projects.length) throw new Error("duplicate project");
    return config;
  } catch { throw new Error("Invalid WORKSPACE_CONFIG; check the documented schema"); }
}
