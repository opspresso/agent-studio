import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
} from "@a2a-js/sdk/server";
import { buildAgentCard } from "@/infrastructure/a2a/cards";
import { ProjectA2aExecutor } from "@/application/a2a/executor";
import { executionDeps, projectRepository, versionRepository } from "@/lib/container";
import { getA2aApiKey } from "@/lib/runtime-settings";
import { sseResponseRaw } from "@/lib/sse";
import { timingSafeEqualString } from "@/infrastructure/crypto/timingSafe";

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Task stores survive across requests so `tasks/get` works after
 * `message/send`; the container is a persistent process (same assumption as
 * the Slack integration). Stores are in-memory and reset on redeploy — this
 * assumes a single instance; horizontal scaling would need a shared store.
 *
 * To bound memory, idle project stores are evicted after a TTL and the total
 * count is capped (LRU eviction).
 */
const TASK_STORE_TTL_MS = 60 * 60 * 1000;
const MAX_TASK_STORES = 100;

const taskStores = new Map<string, { store: InMemoryTaskStore; lastAccess: number }>();

function taskStoreFor(projectName: string): InMemoryTaskStore {
  const now = Date.now();

  for (const [name, entry] of taskStores) {
    if (now - entry.lastAccess > TASK_STORE_TTL_MS) {
      taskStores.delete(name);
    }
  }

  const existing = taskStores.get(projectName);
  if (existing) {
    existing.lastAccess = now;
    return existing.store;
  }

  if (taskStores.size >= MAX_TASK_STORES) {
    let oldestName: string | undefined;
    let oldestAccess = Infinity;
    for (const [name, entry] of taskStores) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestName = name;
      }
    }
    if (oldestName !== undefined) {
      taskStores.delete(oldestName);
    }
  }

  const store = new InMemoryTaskStore();
  taskStores.set(projectName, { store, lastAccess: now });
  return store;
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncGenerator<unknown>)[Symbol.asyncIterator] === "function"
  );
}

/** A2A JSON-RPC endpoint (message/send, message/stream, tasks/get, tasks/cancel). */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const apiKey = await getA2aApiKey();
  if (!apiKey) {
    return Response.json({ error: "A2A is not configured" }, { status: 503 });
  }
  if (!timingSafeEqualString(request.headers.get("x-a2a-key") ?? "", apiKey)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { name } = await ctx.params;
  const project = await projectRepository.get(name);
  if (!project || !project.publishedVersion) {
    return Response.json({ error: "Project not found or has no published version" }, { status: 404 });
  }
  const version = await versionRepository.get(project.name, project.publishedVersion);
  if (!version) {
    return Response.json({ error: "Published version not found" }, { status: 404 });
  }

  const requestHandler = new DefaultRequestHandler(
    await buildAgentCard(project, version),
    taskStoreFor(project.name),
    new ProjectA2aExecutor(executionDeps, project, version),
  );
  const transport = new JsonRpcTransportHandler(requestHandler);

  const body = await request.json().catch(() => null);
  const result = await transport.handle(body);
  if (isAsyncGenerator(result)) {
    return sseResponseRaw(result);
  }
  return Response.json(result);
}
