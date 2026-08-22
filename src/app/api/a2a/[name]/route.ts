import { JsonRpcTransportHandler, A2AError } from "@a2a-js/sdk/server";
import { ProjectA2aExecutor } from "@/application/a2a/executor";
import { ProjectRequestHandler } from "@/application/a2a/requestHandler";
import { a2aExposureDeps, createA2aTaskStore, executionDeps } from "@/lib/container";
import { resolveExposedProject } from "@/application/a2a/exposure";
import { authenticateA2a } from "@/app/api/a2a/_lib/auth";
import { sseResponseRaw } from "@/app/api/_lib/sse";
import { turnBody } from "@/app/api/_lib/body";
import { unauthorized } from "@/shared/unauthorized";

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

/** The request id a JSON-RPC error answers under, read before the SDK has parsed anything. */
function requestIdOf(body: unknown): string | number | null {
  const id = (body as { id?: unknown } | null)?.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

/**
 * A failure as a JSON-RPC error response, status 200 like the reference
 * server's. The SDK's transport answers its own validation this way; what it
 * *throws* instead — a streaming method refused on its first pull, a handler
 * that rejected — arrived here as an HTTP 500 with a non-JSON body, which is
 * not an error a JSON-RPC client can read.
 */
function jsonRpcError(id: string | number | null, error: unknown): Response {
  const a2aError =
    error instanceof A2AError
      ? error
      : A2AError.internalError(error instanceof Error ? error.message : "Internal error");
  return Response.json({ jsonrpc: "2.0", id, error: a2aError.toJSONRPCError() });
}

/** The scheme the card declares, so a client reading the challenge learns what to present. */
const A2A_CHALLENGE = 'ApiKey realm="a2a", header="X-A2A-Key"';

/** A2A JSON-RPC endpoint (message/send, message/stream, tasks/get, tasks/cancel, tasks/resubscribe). */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const auth = await authenticateA2a(request.headers.get("x-a2a-key") ?? "");
  if (auth.status === "unconfigured") {
    return Response.json({ error: "A2A is not configured" }, { status: 503 });
  }
  if (auth.status === "unauthorized") {
    return unauthorized(A2A_CHALLENGE);
  }
  const actor = auth.actor;

  const { name } = await ctx.params;
  const exposed = await resolveExposedProject(a2aExposureDeps, name);
  if (!exposed) {
    return Response.json({ error: "Project not found or has no published version" }, { status: 404 });
  }
  const { project, version, card } = exposed;

  const store = createA2aTaskStore(project.name);
  const requestHandler = new ProjectRequestHandler(
    store,
    card,
    store,
    new ProjectA2aExecutor(executionDeps, project, version, store, actor),
  );
  const transport = new JsonRpcTransportHandler(requestHandler);

  const body = await turnBody(request);
  if (body instanceof Response) {
    return body;
  }
  const id = requestIdOf(body);
  try {
    const result = await transport.handle(body);
    if (isAsyncGenerator(result)) {
      // A refusal on the first pull is a JSON-RPC error; one after the stream
      // has begun is a JSON-RPC error *frame*, which is what every frame of
      // this stream is.
      return await sseResponseRaw(result, undefined, {
        errorFrame: (message) => ({
          jsonrpc: "2.0",
          id,
          error: A2AError.internalError(message).toJSONRPCError(),
        }),
      });
    }
    return Response.json(result);
  } catch (error) {
    return jsonRpcError(id, error);
  }
}
