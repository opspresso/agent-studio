import { DefaultRequestHandler, JsonRpcTransportHandler } from "@a2a-js/sdk/server";
import { ProjectA2aExecutor } from "@/application/a2a/executor";
import { a2aExposureDeps, createA2aTaskStore, executionDeps } from "@/lib/container";
import { resolveExposedProject } from "@/application/a2a/exposure";
import { authenticateA2a } from "@/app/api/a2a/_lib/auth";
import { unauthorized } from "@/shared/unauthorized";
import { sseResponseRaw } from "@/app/api/_lib/sse";
import { turnBody } from "@/app/api/_lib/body";

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
  const auth = await authenticateA2a(request.headers.get("x-a2a-key") ?? "");
  if (auth.status === "unconfigured") {
    return Response.json({ error: "A2A is not configured" }, { status: 503 });
  }
  if (auth.status === "unauthorized") {
    return unauthorized();
  }
  const actor = auth.actor;

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
    new ProjectA2aExecutor(executionDeps, project, version, store, actor),
  );
  const transport = new JsonRpcTransportHandler(requestHandler);

  const body = await turnBody(request);
  if (body instanceof Response) {
    return body;
  }
  const result = await transport.handle(body);
  if (isAsyncGenerator(result)) {
    return await sseResponseRaw(result);
  }
  return Response.json(result);
}
