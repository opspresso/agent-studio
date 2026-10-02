/** Offline integration fixture: real native protocols and gateway, synthetic persistence/provider. */
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { writeFileSync } from "node:fs";
import { createWorkspaceModelGateway } from "@/application/workspace/modelGateway";
import { createWorkspaceModelTokens } from "@/infrastructure/workspace/modelToken";
import { createWorkspaceModelTransport } from "@/infrastructure/workspace/modelTransport";
import { replaceModelRegistry } from "@/domain/llm/models";
import type { Workspace, WorkspaceRun, WorkspaceModelRuntime } from "@/domain/workspace/types";
import type { WorkspaceModelCall } from "@/domain/workspace/modelGateway";
import type { RunIdentity } from "@/domain/execution/actor";
import type { UsageDelta } from "@/domain/usage/types";

const protocols = { codex: "responses", claude: "messages", opencode: "chat/completions" } as const;
const wireModels = { codex: "native-codex", claude: "claude-sonnet-4-6", opencode: "native-opencode" };
const entries = new Map<string, { workspace: Workspace; run: WorkspaceRun }>();
const pending = new Map<string, WorkspaceModelCall>();
const usage = new Map<string, UsageDelta>();
const requests: Array<{ path: string; model: string; authorized: boolean }> = [];
let sequence = 0;
replaceModelRegistry(Object.keys(protocols).map(runtime => ({ id: `fixture/${runtime}`, provider: "fixture", displayName: runtime, maker: "test", family: "test",
  pricing: { inputPer1M: 1, outputPer1M: 1 }, contextWindow: 100000, maxTokens: 10000,
  capabilities: { tools: true, imageInput: false, structuredOutput: false, reasoning: false } })));
const gateway = createWorkspaceModelGateway({
  workspaces: { get: async (id: string) => entries.get(id)?.workspace ?? null, run: async (id: string) => entries.get(id)?.run ?? null },
  agents: { get: async () => ({ name: "fixture", ownerEmail: "fixture@example.test" }) },
  calls: { begin: async (call: WorkspaceModelCall) => { if (pending.has(call.runId)) return false; pending.set(call.runId, call); return true; },
    get: async (_ws: string, run: string) => pending.get(run) ?? null,
    capture: async (call: WorkspaceModelCall) => { pending.set(call.runId, call); }, finish: async (call: WorkspaceModelCall) => { pending.delete(call.runId); } },
  tokens: createWorkspaceModelTokens(Buffer.alloc(32, 3)),
  transport: createWorkspaceModelTransport(async model => ({ providerName: "selfhosted", auth: "bearer", apiKey: "synthetic-provider-key",
    baseUrl: "http://127.0.0.1:19091/v1", model: wireModels[model.split("/")[1] as WorkspaceModelRuntime] })),
  selection: async (runtime: WorkspaceModelRuntime) => ({ model: `fixture/${runtime}`, wireModel: wireModels[runtime], protocol: protocols[runtime] }),
  authorize: async (_agent: string, identity: RunIdentity) => { if (identity.user.userId !== "fixture-user") throw new Error("Wrong caller"); },
  limits: async () => ({}), pricingPolicy: async () => "refuse",
  usage: { record: async (delta: UsageDelta) => {
    const previous = usage.get(delta.idempotencyKey!);
    if (previous && JSON.stringify(previous) !== JSON.stringify(delta)) throw new Error("Changed accounting receipt");
    usage.set(delta.idempotencyKey!, delta);
  } }, now: () => new Date(), newId: () => `model-${++sequence}`, runTimeoutMs: 60_000,
} as unknown as Parameters<typeof createWorkspaceModelGateway>[0]);

createServer((request, response) => {
  let raw = "";
  request.on("data", chunk => { raw += chunk; });
  request.on("end", () => {
    const body = JSON.parse(raw || "{}");
    const path = request.url!.split("?")[0]!;
    if (path === "/v1/messages/count_tokens") { response.setHeader("content-type", "application/json"); response.end('{"input_tokens":10}'); return; }
    requests.push({ path, model: body.model, authorized: (request.headers.authorization === "Bearer synthetic-provider-key" || request.headers["x-api-key"] === "synthetic-provider-key") });
    const n = requests.length;
    const send = (event: unknown, name?: string) => response.write((name ? `event: ${name}\n` : "") + `data: ${JSON.stringify(event)}\n\n`);
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (path === "/v1/responses") {
      const message = { id: `msg_${n}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "gateway-ok", annotations: [] }] };
      const result = { id: `resp_${n}`, object: "response", created_at: 1, status: "completed", model: body.model,
        output: [message], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
      for (const event of [
        { type: "response.created", response: { ...result, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: message.id, delta: "gateway-ok" },
        { type: "response.output_item.done", output_index: 0, item: message }, { type: "response.completed", response: result },
      ]) send(event, event.type);
    } else if (path === "/v1/messages") {
      const message = { id: `msg_${n}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 0 } };
      for (const event of [{ type: "message_start", message }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "gateway-ok" } }, { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }, { type: "message_stop" }]) send(event, event.type);
    } else {
      const base = { id: `chatcmpl_${n}`, object: "chat.completion.chunk", created: 1, model: body.model };
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "gateway-ok" }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
      response.write("data: [DONE]\n\n");
    }
    response.end();
  });
}).listen(19091, "127.0.0.1");

createServer(async (request, response) => {
  try {
    const url = new URL(request.url!, "http://127.0.0.1:19090");
    if (url.pathname === "/credential") {
      const runtime = url.searchParams.get("runtime") as WorkspaceModelRuntime;
      const id = runtime + "-" + url.searchParams.get("run");
      const workspace = { id, agentName: "fixture", runtime, ownerEmail: "fixture@example.test", status: "active", activeRunId: id } as Workspace;
      const run = { id, workspaceId: id, user: { userId: "fixture-user", email: workspace.ownerEmail }, actor: { kind: "user", id: workspace.ownerEmail },
        status: "running", phase: "runtime", operationId: id, startedAt: new Date().toISOString() } as WorkspaceRun;
      entries.set(id, { workspace, run }); response.end(JSON.stringify(await gateway.credential(workspace, run))); return;
    }
    if (url.pathname === "/report") { response.end(JSON.stringify({ requests, usage: [...usage.values()], pending: pending.size })); return; }
    if (url.pathname.endsWith("/api/hello")) { response.end("{}"); return; }
    const token = request.headers.authorization?.replace(/^Bearer /i, "") ?? String(request.headers["x-api-key"] ?? "");
    await gateway.authorize(token);
    let body = ""; for await (const chunk of request) { body += chunk; if (body.length > 8 * 1024 * 1024) throw new Error("Fixture body limit"); }
    const parsed = JSON.parse(body);
    writeFileSync("/control/model-gateway-shape.json", JSON.stringify({ fields: Object.keys(parsed), tools: parsed.tools?.map((tool: { type?: string; name?: string }) => ({ type: tool.type, name: tool.name })), inputTypes: parsed.input?.map?.((item: { type?: string; role?: string }) => ({ type: item.type, role: item.role })) }));
    const result = await gateway.forward(token, url.pathname.replace(/^\/api\/workspace-model\//, ""), parsed, {}, new AbortController().signal);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    if (result.body) Readable.fromWeb(result.body as import("node:stream/web").ReadableStream).pipe(response); else response.end();
  } catch (error) { response.statusCode = (error as { status?: number }).status ?? 500; response.end(JSON.stringify({ error: "Fixture gateway refused request" })); }
}).listen(19090, "127.0.0.1", () => writeFileSync("/control/model-gateway-ready", "ready"));
