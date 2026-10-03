import type { AgentRepository } from "@/domain/agent/repository";
import type { RunIdentity, RunUser } from "@/domain/execution/actor";
import { actorKey } from "@/domain/execution/actor";
import type { TierLimits } from "@/domain/member/tiers";
import type { WorkspaceRepository } from "@/domain/workspace/repository";
import type { Workspace, WorkspaceModelRuntime, WorkspaceRun } from "@/domain/workspace/types";
import type { WorkspaceModelCall, WorkspaceModelCalls, WorkspaceModelClaims, WorkspaceModelTokens, WorkspaceModelTransport, NativeModelProtocol } from "@/domain/workspace/modelGateway";
import type { CostGuardDeps } from "@/application/usage/costGuard";
import { assertWithinCostLimit } from "@/application/usage/costGuard";
import { assertWithinMemberCostLimit } from "@/application/usage/memberCostGuard";
import { assertModelsPriceable, type UnknownModelPolicy } from "@/application/run/modelPolicy";
import { modelResponseUsage } from "@/application/runtime/modelUsage";
import { ConflictError, ForbiddenError, RateLimitedError, ValidationError } from "@/application/errors";

export interface WorkspaceModelSelection { model: string; wireModel: string; protocol: NativeModelProtocol }
interface GatewayDeps extends CostGuardDeps {
  workspaces: WorkspaceRepository;
  agents: AgentRepository;
  calls: WorkspaceModelCalls;
  tokens: WorkspaceModelTokens;
  transport: WorkspaceModelTransport;
  selection(runtime: WorkspaceModelRuntime): Promise<WorkspaceModelSelection | undefined>;
  authorize(agentName: string, identity: RunIdentity): Promise<void>;
  limits(user: RunUser): Promise<TierLimits>;
  pricingPolicy(): Promise<UnknownModelPolicy>;
  now(): Date;
  newId(): string;
  runTimeoutMs: number;
}
const UNCERTAIN_USAGE = "Native model usage could not be fully confirmed. The request was not replayed; provider billing may exceed recorded usage.";

/** Provider account resources are not part of a Workspace's native history. */
function assertNativeContext(body: Record<string, unknown>, protocol: NativeModelProtocol) {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const refuse = () => { throw new ForbiddenError("Native runs must send their own complete model context without hosted provider resources"); };
  const allowed = new Set((protocol === "responses"
    ? "model input instructions tools tool_choice parallel_tool_calls text reasoning stream stream_options max_output_tokens temperature top_p metadata service_tier truncation store include prompt_cache_key prompt_cache_retention safety_identifier user max_tool_calls context_management client_metadata"
    : protocol === "messages"
      ? "model messages system tools tool_choice max_tokens metadata stop_sequences stream temperature thinking top_k top_p service_tier cache_control output_config context_management inference_geo"
      : "model messages tools tool_choice max_completion_tokens max_tokens temperature top_p stop stream stream_options parallel_tool_calls frequency_penalty presence_penalty seed user response_format reasoning_effort verbosity logit_bias logprobs top_logprobs prediction metadata modalities audio store service_tier prompt_cache_key prompt_cache_retention safety_identifier").split(" "));
  if (Object.keys(body).some(key => !allowed.has(key))) refuse();
  if (body.previous_response_id != null || body.conversation != null || body.container != null) refuse();
  const safeTool = (value: unknown): boolean => {
    const tool = object(value);
    if (protocol === "messages") return tool.type == null || tool.type === "custom";
    if (tool.type === "namespace") return Array.isArray(tool.tools) && tool.tools.every(child => ["function", "custom"].includes(String(object(child).type)));
    return ["function", "custom"].includes(String(tool.type));
  };
  if (Array.isArray(body.tools) && !body.tools.every(safeTool)) refuse();
  const items = protocol === "responses" ? body.input : body.messages;
  if (!Array.isArray(items)) return;
  const pending: unknown[] = [items];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const child of value) pending.push(child);
      continue;
    }
    const item = object(value);
    const source = object(item.source);
    if (item.type === "item_reference" || (item.id != null && item.type == null && item.role == null)) refuse();
    if (object(item.audio).id != null) refuse();
    if (item.file_id != null || object(item.file).file_id != null || source.file_id != null || source.type === "file") refuse();
    // Traverse protocol content containers; tool arguments remain application-defined data.
    for (const nested of [item.content, item.output, source.content]) {
      if (nested && typeof nested === "object") pending.push(nested);
    }
  }
}

/** Native requests reuse the worker's run slot; they never open a nested Agent/model loop. */
export function createWorkspaceModelGateway(deps: GatewayDeps) {
  async function context(token: string) {
    const claims = deps.tokens.verify(token, Math.floor(deps.now().getTime() / 1000));
    if (!claims) throw new ForbiddenError("Invalid or expired Workspace model credential");
    const [workspace, run] = await Promise.all([deps.workspaces.get(claims.workspaceId), deps.workspaces.run(claims.workspaceId, claims.runId)]);
    if (!workspace || !run || workspace.activeRunId !== run.id || workspace.runtime !== claims.runtime ||
      workspace.status !== "active" || workspace.deleteRequestedAt || run.status !== "running" || run.phase !== "runtime" ||
      run.cancelRequestedAt || !run.startedAt || run.operationId !== run.id ||
      deps.now().getTime() >= Date.parse(run.startedAt) + deps.runTimeoutMs || run.user.email !== workspace.ownerEmail) {
      throw new ForbiddenError("Workspace run is no longer authorized for model requests");
    }
    await deps.authorize(workspace.agentName, run);
    const selected = await deps.selection(claims.runtime);
    if (!selected || selected.model !== claims.model) throw new ForbiddenError("Workspace model selection changed");
    return { claims, workspace, run, selected };
  }
  return {
    async credential(workspace: Workspace, run: WorkspaceRun) {
      if (workspace.runtime === "command" || !run.startedAt) throw new ValidationError("Native model credentials require an admitted run");
      const selected = await deps.selection(workspace.runtime);
      if (!selected) throw new ValidationError("Workspace runtime model is not configured in Models");
      const claims: WorkspaceModelClaims = { workspaceId: workspace.id, runId: run.id, runtime: workspace.runtime,
        model: selected.model, expiresAt: Math.ceil((Date.parse(run.startedAt) + deps.runTimeoutMs) / 1000) };
      return { token: deps.tokens.issue(claims), selected };
    },
    authorize: async (token: string) => { await context(token); },
    settle: (workspaceId: string, runId: string) => settleWorkspaceModelCall(deps, workspaceId, runId),
    async forward(token: string, path: string, body: Record<string, unknown>, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
      const { claims, workspace, run, selected } = await context(token);
      assertNativeContext(body, selected.protocol);
      if (selected.protocol === "responses") body = { ...body, store: false };
      const countTokens = selected.protocol === "messages" && path === "v1/messages/count_tokens";
      if (body.background === true || (!countTokens && path !== "v1/" + selected.protocol) || body.model !== selected.wireModel) throw new ForbiddenError("Native model endpoint or model is outside this run's scope");
      const agent = await deps.agents.get(workspace.agentName);
      if (!agent) throw new ForbiddenError("Agent is no longer available");
      assertModelsPriceable(await deps.pricingPolicy(), { model: selected.model });
      await assertWithinCostLimit(deps, agent);
      await assertWithinMemberCostLimit(deps, run.user, await deps.limits(run.user), deps.now());
      const call = { id: deps.newId(), workspaceId: workspace.id, runId: run.id, startedAt: deps.now().toISOString() };
      if (!await deps.calls.begin(call)) {
        const pending = await deps.calls.get(workspace.id, run.id);
        if (pending?.uncertain) throw new ConflictError(UNCERTAIN_USAGE);
        throw new RateLimitedError("A native model request is already in progress or awaiting accounting", 1);
      }
      try {
        // Reading a large request or the budget must not preserve a revoked grant.
        await context(token);
      } catch (error) { await deps.calls.finish(call); throw error; }
      let captured: WorkspaceModelCall | undefined;
      return deps.transport.forward({ model: claims.model, protocol: selected.protocol, body, headers, countTokens,
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, claims.expiresAt * 1000 - deps.now().getTime()))]),
        finish: async (usage, complete) => {
          if (!usage && complete) {
            if ((await deps.calls.get(call.workspaceId, call.runId))?.id === call.id) await deps.calls.finish(call);
            return;
          }
          const billed = usage ? modelResponseUsage(selected.model, { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
            inputTokensDetails: { cached_tokens: usage.cachedTokens }, outputTokensDetails: { reasoning_tokens: usage.reasoningTokens } },
            rawUsage: { cost_usd: usage.costUsd } }) : undefined;
          captured ??= { ...call, ...(!complete ? { uncertain: true as const } : {}),
            ...(billed ? { usage: { idempotencyKey: "native:" + call.id, agentName: workspace.agentName, userId: run.user.userId,
              actor: actorKey(run.actor), date: call.startedAt.slice(0, 10), model: selected.model, calls: 1,
              inputTokens: billed.inputTokens, outputTokens: billed.outputTokens, cachedTokens: billed.cachedTokens ?? 0, costUsd: billed.costUsd } } : {}) };
          const pending = await deps.calls.get(call.workspaceId, call.runId);
          if (pending?.id === call.id) {
            await deps.calls.capture(captured);
            await settleWorkspaceModelCall(deps, workspace.id, run.id);
          } else if (captured.usage && !captured.uncertain) {
            // Completion may have committed before its acknowledgement was lost.
            // Settle the same receipt and leave any newer request's claim intact.
            await deps.usage.record(captured.usage);
          } else throw new ConflictError("Native accounting claim changed before usage was confirmed");
        },
      });
    },
  };
}

export async function settleWorkspaceModelCall(deps: Pick<GatewayDeps, "calls" | "usage">, workspaceId: string, runId: string): Promise<string | undefined> {
    const call = await deps.calls.get(workspaceId, runId);
    if (!call) return undefined;
    if (call.usage) await deps.usage.record(call.usage);
    if (!call.usage || call.uncertain) return UNCERTAIN_USAGE;
    await deps.calls.finish(call);
    return undefined;
  }
