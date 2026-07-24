import { DefaultRequestHandler, JsonRpcTransportHandler } from "@a2a-js/sdk/server";
import { buildAgentCard } from "@/infrastructure/a2a/cards";
import { ProjectA2aExecutor } from "@/application/a2a/executor";
import {
  createA2aTaskStore,
  executionDeps,
  projectRepository,
  versionRepository,
} from "@/lib/container";
import { getA2aApiKey } from "@/lib/runtime-settings";
import { resolveRunnableVersion } from "@/application/project/resolveRunnableVersion";
import { sseResponseRaw } from "@/lib/sse";
import { timingSafeEqualString } from "@/infrastructure/crypto/timingSafe";

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Task state is persisted in DynamoDB (per-project namespace, TTL-expired) so
 * `tasks/get`/`tasks/cancel` work after `message/send` across instance restarts
 * and horizontal scaling. See `@/infrastructure/a2a/taskStore`.
 */

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
  // External surface: published-only (resolveRunnableVersion policy).
  const version = project ? await resolveRunnableVersion(versionRepository, project) : null;
  if (!project || !version) {
    return Response.json({ error: "Project not found or has no published version" }, { status: 404 });
  }

  const requestHandler = new DefaultRequestHandler(
    await buildAgentCard(project, version),
    createA2aTaskStore(project.name),
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
