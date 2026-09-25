import { z } from "zod";

const backendSchema = z.object({
  image: z.string().trim().min(1).max(300),
  network: z.string().trim().min(1).max(100).default("none"),
  context: z.string().trim().min(1).max(100).optional(),
  memoryMb: z.coerce.number().int().min(128).max(65536).default(2048),
  diskMb: z.coerce.number().int().min(64).max(65536).default(2048),
  cpus: z.coerce.number().min(0.1).max(64).default(2),
  workerConcurrency: z.coerce.number().int().min(1).max(32).default(4),
});
export type WorkspaceConfig = z.infer<typeof backendSchema>;

/** Only Sandbox infrastructure is deployment-owned. Agent tools and models live in the database. */
export function parseWorkspaceConfig(env: Record<string, string | undefined>): WorkspaceConfig | undefined {
  if (!env.WORKSPACE_IMAGE?.trim()) return undefined;
  try { return backendSchema.parse({ image: env.WORKSPACE_IMAGE, network: env.WORKSPACE_NETWORK,
    context: env.WORKSPACE_DOCKER_CONTEXT, memoryMb: env.WORKSPACE_MEMORY_MB, diskMb: env.WORKSPACE_DISK_MB,
    cpus: env.WORKSPACE_CPUS, workerConcurrency: env.WORKSPACE_WORKER_CONCURRENCY }); }
  catch { throw new Error("Invalid Workspace Sandbox infrastructure configuration"); }
}
