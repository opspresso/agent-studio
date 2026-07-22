import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
} from "@a2a-js/sdk/server";
import { buildAgentCard } from "@/infrastructure/a2a/cards";
import { ProjectA2aExecutor } from "@/application/a2a/executor";
import { executionDeps, projectRepository, versionRepository } from "@/lib/container";
import { config } from "@/lib/config";
import { sseResponseRaw } from "@/lib/sse";

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Task stores survive across requests so `tasks/get` works after
 * `message/send`; the container is a persistent process (same assumption as
 * the Slack integration). Stores are in-memory and reset on redeploy.
 */
const taskStores = new Map<string, InMemoryTaskStore>();

function taskStoreFor(projectName: string): InMemoryTaskStore {
  let store = taskStores.get(projectName);
  if (!store) {
    store = new InMemoryTaskStore();
    taskStores.set(projectName, store);
  }
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
  const apiKey = config.a2aApiKey;
  if (!apiKey) {
    return Response.json({ error: "A2A is not configured" }, { status: 503 });
  }
  if (request.headers.get("x-a2a-key") !== apiKey) {
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
    buildAgentCard(project, version),
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
