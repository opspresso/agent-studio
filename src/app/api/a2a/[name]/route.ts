import { A2A_VERSION_HEADER } from "@a2a-js/sdk";
import {
  JsonRpcTransportHandler,
  ServerCallContext,
  validateVersion,
  type User,
} from "@a2a-js/sdk/server";
import { ProjectA2aExecutor } from "@/application/a2a/executor";
import { ProjectRequestHandler } from "@/application/a2a/requestHandler";
import { a2aExposureDeps, createA2aTaskStore, executionDeps } from "@/lib/container";
import { resolveExposedProject } from "@/application/a2a/exposure";
import { authenticateA2a } from "@/app/api/a2a/_lib/auth";
import {
  a2aJsonParseError,
  tenantFromA2aJsonRpcRequest,
  withRequiredA2aDefaults,
} from "@/app/api/a2a/_lib/jsonRpc";
import { withTurnBodyText } from "@/app/api/_lib/body";
import { sseResponseRaw } from "@/app/api/_lib/sse";
import { unauthorized } from "@/shared/unauthorized";

type RouteContext = { params: Promise<{ name: string }> };

/**
 * Task state is persisted in the database (per-project namespace, TTL-expired) so
 * `GetTask`/`CancelTask` work after `SendMessage` across instance restarts
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

function parseJsonRpcEnvelope(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * A failure as a JSON-RPC error response, status 200 like the reference
 * server's. The SDK's transport answers its own validation this way; what it
 * *throws* instead — a streaming method refused on its first pull, a handler
 * that rejected — arrived here as an HTTP 500 with a non-JSON body, which is
 * not an error a JSON-RPC client can read.
 */
function jsonRpcError(id: string | number | null, error: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, error: JsonRpcTransportHandler.mapToJSONRPCError(error) });
}

/** The scheme the card declares, so a client reading the challenge learns what to present. */
const A2A_CHALLENGE = 'ApiKey realm="a2a", header="X-A2A-Key"';

/** Native A2A 1.0 JSON-RPC endpoint. */
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

  return withTurnBodyText(request, async (rawBody) => {
    const body = parseJsonRpcEnvelope(rawBody);
    const id = requestIdOf(body);
    if (body === undefined) {
      // The SDK currently maps SyntaxError to RequestMalformed (-32600), while
      // A2A 1.0 explicitly reserves -32700 for an invalid JSON payload.
      return Response.json(a2aJsonParseError());
    }

    const store = createA2aTaskStore(project.name);
    const user: User = {
      get isAuthenticated() {
        return true;
      },
      get userName() {
        return actor.id;
      },
    };
    const callContext = new ServerCallContext({
      user,
      tenant: tenantFromA2aJsonRpcRequest(body),
      requestedVersion: request.headers.get(A2A_VERSION_HEADER) ?? undefined,
    });
    // The reader leaving ends a resubscribe's polling; a run itself is not
    // cancelled by it — `CancelTask` is how a task is cancelled.
    const abortController = new AbortController();
    const requestHandler = new ProjectRequestHandler(
      store,
      { signal: abortController.signal },
      card,
      store,
      new ProjectA2aExecutor(executionDeps, project, version, store, actor, callContext),
    );
    const transport = new JsonRpcTransportHandler(requestHandler);

    try {
      // A2A 1.0 requires version negotiation through the service parameter.
      // Missing means 0.3 in the SDK context and is rejected because this
      // unopened service intentionally exposes only the native 1.0 contract.
      validateVersion(callContext.requestedVersion, card, "JSONRPC");
      const result = await transport.handle(rawBody, callContext);
      if (isAsyncGenerator(result)) {
        // A refusal on the first pull is a JSON-RPC error; one after the stream
        // has begun is a JSON-RPC error *frame*, which is what every frame of
        // this stream is.
        return await sseResponseRaw(result, abortController, {
          errorFrame: (message) => ({
            jsonrpc: "2.0",
            id,
            error: JsonRpcTransportHandler.mapToJSONRPCError(new Error(message)),
          }),
        });
      }
      return Response.json(
        withRequiredA2aDefaults((body as { method?: unknown } | null)?.method, result),
      );
    } catch (error) {
      return jsonRpcError(id, error);
    }
  });
}
