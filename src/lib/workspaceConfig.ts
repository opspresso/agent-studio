import { z } from "zod";

const resources = z.object({
  modelGatewayUrl: z.string().url().refine(value => { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }).optional(),
  image: z.string().trim().min(1).max(300),
  network: z.string().trim().min(1).max(100).default("none"),
  context: z.string().trim().min(1).max(100).optional(),
  memoryMb: z.coerce.number().int().min(128).max(65536).default(2048),
  diskMb: z.coerce.number().int().min(64).max(65536).default(2048),
  cpus: z.coerce.number().min(0.1).max(64).default(2),
  workerConcurrency: z.coerce.number().int().min(1).max(32).default(4),
  continuationConcurrency: z.coerce.number().int().min(1).max(32).optional(),
  checkpointHistory: z.enum(["retention", "latest"]).default("retention"),
});
const backendSchema = z.discriminatedUnion("provider", [
  resources.extend({ provider: z.literal("docker") }),
  resources.extend({ provider: z.literal("kubernetes"),
    namespace: z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).max(63),
    instance: z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).max(63),
    kubeContext: z.string().trim().min(1).max(300).optional(),
    nodePool: z.string().trim().min(1).max(63).optional(),
    imagePullSecret: z.string().trim().min(1).max(63).optional(),
    legacyDocker: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  }),
]);
const workspaceSchema = backendSchema.transform(config => ({ ...config,
  continuationConcurrency: config.continuationConcurrency ?? Math.min(config.workerConcurrency, 2),
}));
export type WorkspaceConfig = z.infer<typeof workspaceSchema>;

/** Only Sandbox infrastructure is deployment-owned. Agent tools and models live in the database. */
export function parseWorkspaceConfig(env: Record<string, string | undefined>): WorkspaceConfig | undefined {
  if (!env.WORKSPACE_IMAGE?.trim()) return undefined;
  try { return workspaceSchema.parse({ provider: env.WORKSPACE_PROVIDER ?? "docker", image: env.WORKSPACE_IMAGE, network: env.WORKSPACE_NETWORK,
    modelGatewayUrl: env.WORKSPACE_MODEL_GATEWAY_URL, context: env.WORKSPACE_DOCKER_CONTEXT, memoryMb: env.WORKSPACE_MEMORY_MB, diskMb: env.WORKSPACE_DISK_MB,
    cpus: env.WORKSPACE_CPUS, workerConcurrency: env.WORKSPACE_WORKER_CONCURRENCY,
    continuationConcurrency: env.WORKSPACE_CONTINUATION_CONCURRENCY,
    checkpointHistory: env.WORKSPACE_CHECKPOINT_HISTORY,
    namespace: env.WORKSPACE_NAMESPACE, instance: env.WORKSPACE_INSTANCE, kubeContext: env.WORKSPACE_KUBERNETES_CONTEXT,
    nodePool: env.WORKSPACE_NODE_POOL, imagePullSecret: env.WORKSPACE_IMAGE_PULL_SECRET, legacyDocker: env.WORKSPACE_LEGACY_DOCKER }); }
  catch { throw new Error("Invalid Workspace Sandbox infrastructure configuration"); }
}
