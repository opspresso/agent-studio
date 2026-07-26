import { DefaultRequestHandler, JsonRpcTransportHandler } from "@a2a-js/sdk/server";
import { ProjectA2aExecutor } from "@/application/a2a/executor";
import { a2aExposureDeps, createA2aTaskStore, executionDeps } from "@/lib/container";
import { resolveExposedProject } from "@/application/a2a/exposure";
import { getA2aApiKey } from "@/lib/runtime-settings";
import { unauthorized } from "@/shared/unauthorized";
import { sseResponseRaw } from "@/app/api/_lib/sse";
import { timingSafeEqualString } from "@/shared/timingSafe";

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
    return unauthorized();
  }

  const { name } = await ctx.params;
  const exposed = await resolveExposedProject(a2aExposureDeps, name);
  if (!exposed) {
    return Response.json({ error: "Project not found or has no published version" }, { status: 404 });
  }
  const { project, version, card } = exposed;

  const store = createA2aTaskStore(project.name);
  const requestHandler = new DefaultRequestHandler(
    card,
    store,
    new ProjectA2aExecutor(executionDeps, project, version, store),
  );
  const transport = new JsonRpcTransportHandler(requestHandler);

  const body = await request.json().catch(() => null);
  const result = await transport.handle(body);
  if (isAsyncGenerator(result)) {
    return sseResponseRaw(result);
  }
  return Response.json(result);
}
