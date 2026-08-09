import { DefaultRequestHandler, JsonRpcTransportHandler } from "@a2a-js/sdk/server";
import { ProjectA2aExecutor } from "@/application/a2a/executor";
import {
  a2aClientKeyUseCases,
  a2aExposureDeps,
  createA2aTaskStore,
  executionDeps,
} from "@/lib/container";
import { resolveExposedProject } from "@/application/a2a/exposure";
import { getA2aApiKey } from "@/lib/runtime-settings";
import { unauthorized } from "@/shared/unauthorized";
import { sseResponseRaw } from "@/app/api/_lib/sse";
import { timingSafeEqualString } from "@/shared/timingSafe";
import { A2A_ACTOR_ID, type RunActor } from "@/domain/execution/actor";

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

/**
 * Which identity a presented `X-A2A-Key` authenticates. The shared app key is
 * every caller as one anonymous actor; a named client key is its holder, so
 * their runs are attributed and bounded per client. `null` is a wrong key.
 */
async function resolveA2aActor(provided: string): Promise<RunActor | null> {
  const sharedKey = await getA2aApiKey();
  if (sharedKey && timingSafeEqualString(provided, sharedKey)) {
    return { kind: "a2a", id: A2A_ACTOR_ID };
  }
  if (provided) {
    const clientName = await a2aClientKeyUseCases.verify(provided);
    if (clientName) {
      return { kind: "a2a", id: clientName };
    }
  }
  return null;
}

/** A2A JSON-RPC endpoint (message/send, message/stream, tasks/get, tasks/cancel). */
export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const actor = await resolveA2aActor(request.headers.get("x-a2a-key") ?? "");
  if (!actor) {
    // With no shared key configured the surface used to be off outright; a
    // named client key now also opens it, so "not configured" is only true
    // when the shared key is unset *and* the presented key matched nothing.
    if (!(await getA2aApiKey())) {
      return Response.json({ error: "A2A is not configured" }, { status: 503 });
    }
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
    new ProjectA2aExecutor(executionDeps, project, version, store, actor),
  );
  const transport = new JsonRpcTransportHandler(requestHandler);

  const body = await request.json().catch(() => null);
  const result = await transport.handle(body);
  if (isAsyncGenerator(result)) {
    return await sseResponseRaw(result);
  }
  return Response.json(result);
}
