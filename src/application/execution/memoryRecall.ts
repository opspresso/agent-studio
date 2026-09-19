/**
 * How a run primes its memory — the single owner of what is asked, of whom,
 * and what the answer becomes.
 *
 * A memory server (mcp-memory) keeps what outlives a run and offers it through
 * a `recall(query)` tool. Left to the tool alone, the model has to think of
 * asking, and the run that did not starts from nothing — the one limitation
 * the server itself names. So a version that opts in (`parameters.memoryRecall`)
 * has the *run* ask, once, before the first token: every bound server offering
 * `recall` is called with the newest user turn, and what came back is put in
 * the system prompt as something the run already knows.
 *
 * Kept out of the engine, which knows nothing about memory: it receives the
 * recalled text as an input field, exactly as it receives the caller. And kept
 * to the tool contract rather than a memory port of its own, because the
 * platform's boundary for what outlives a run is MCP — a second, native store
 * beside a bound memory server would be two answers to "what does this project
 * remember".
 */

import type * as engine from "@/application/runtime";
import { bindingsMayOfferRecall, RECALL_TOOL_NAME } from "@/domain/project/memoryRecall";
import type { AgentConfiguration } from "@/domain/project/types";
import type { RunOrigin } from "@/domain/execution/actor";
import { buildMcpTools, closeMcp, type McpToolDeps, type ResolvedMcp } from "./mcpTools";
import { log } from "@/shared/logger";
import { unrefTimer } from "@/shared/unrefTimer";
import { cutCodePoints } from "@/shared/utf8Text";

/**
 * How much of a recall may enter the prompt. This platform's own policy: a
 * memory server answers ranked and bounded already, and the cap is what keeps
 * one talkative server from spending the context on the past before the
 * present has been read. A cut carries a marker, like every other cut here.
 */
export const MAX_RECALLED_CHARS = 4_000;

/** How much of a user turn is sent as the query — a question, not a document. */
const MAX_QUERY_CHARS = 2_000;

/** How long a recall may hold up the first token; past it the run goes on without. */
const RECALL_TIMEOUT_MS = 10_000;

export interface RecallResult {
  /** What the run remembers, ready for the prompt; absent when nothing came back. */
  remembered?: string;
  /** What was lost — a server that failed, a version with nothing to ask. */
  warnings: string[];
  /** Servers actually asked. Zero when there was none to ask, or nothing to ask with. */
  asked: number;
  /**
   * Of those, how many failed.
   *
   * Told apart from `warnings` because they are not the same event: a version
   * bound to no memory server warns on every run it will ever make, and marking
   * *that* as a stage failure would put a red span on every trace of a
   * permanently misconfigured version — the same dilution the discovery/warning
   * split exists to avoid. A server that was asked and did not answer is the
   * one worth flagging.
   */
  failed: number;
}

/**
 * Which servers a run would recall from, without asking any of them — the
 * preview's question. Separate from the recall itself so an empty query is
 * never a way of saying "just look": at run time an empty query is a loss.
 *
 * Only the servers the version **bound**: a resolve may have been widened by
 * discovery, and a server the catalog added for this request is not one the
 * author decided to hand every request to before the model has said a word.
 * The discovered server's `recall` stays a tool the model may call.
 */
export function recallTargets(
  mcp: Pick<ResolvedMcp, "mcpServers" | "aliasFor">,
  configuration: Pick<AgentConfiguration, "mcpList">,
): Array<{ server: string; alias: string }> {
  const bound = new Set((configuration.mcpList ?? []).map((binding) => binding.name));
  return mcp.mcpServers.flatMap((server) => {
    const alias = bound.has(server.name) ? mcp.aliasFor?.(server.name, RECALL_TOOL_NAME) : undefined;
    return alias ? [{ server: server.name, alias }] : [];
  });
}

/**
 * The warning both callers raise when a version recalls and nothing offers it.
 * "On this run", because a server may well have the tool and this run may not
 * be offering it — past the per-run tool cap, or narrowed out by the binding —
 * and the cap's own warning says which.
 */
export function noRecallTargetWarning(): string {
  return `Memory recall is on, but no bound MCP server offers a '${RECALL_TOOL_NAME}' tool on this run; the run started without a memory.`;
}

/**
 * What the memory stage reports on its trace span — the second half of the pair
 * `toolsPrepared` owns, and here for the same reason: two run levels record it,
 * and a field added to one copy is a field the other silently stops carrying.
 *
 * `status` is the part worth stating: a server that was asked and did not
 * answer is a stage that failed, while a version bound to nothing that offers
 * `recall` warns on every run it will ever make — flagging *that* red puts an
 * error on every trace a misconfigured version writes.
 */
export function memoryPrepared(memory: {
  input: Pick<engine.RunAgentInput, "remembered">;
  warnings: readonly string[];
  asked: number;
  failed: number;
}): { status: "ok" | "error"; output: Record<string, unknown> } {
  return {
    status: memory.failed > 0 ? "error" : "ok",
    output: {
      remembered: memory.input.remembered?.length ?? 0,
      asked: memory.asked,
      ...(memory.failed > 0 ? { failed: memory.failed } : {}),
      ...(memory.warnings.length > 0 ? { warnings: memory.warnings.length } : {}),
    },
  };
}

/** Recall only explicit bindings before the catalog chooses the run's capabilities. */
export async function prepareMemoryForRun(
  deps: McpToolDeps,
  input: {
    configuration: AgentConfiguration;
    query: string;
    signal?: AbortSignal;
    origin?: Pick<RunOrigin, "actor" | "userEmail" | "conversation" | "backgroundTask">;
  },
): Promise<Awaited<ReturnType<typeof recallForRun>>> {
  if (input.origin?.backgroundTask || !input.configuration.parameters.memoryRecall) {
    return { input: {}, warnings: [], asked: 0, failed: 0 };
  }
  // Preserve binding selections: an unrestricted document server need not
  // offer recall. Inventing that selection would report a missing-tool warning.
  // Only recall is called; final resolution reuses the cached catalogs.
  const mcp = await buildMcpTools(deps, {
    ...input.configuration,
    mcpList: (input.configuration.mcpList ?? [])
      .filter((binding) => bindingsMayOfferRecall([binding])),
  }, input.signal, input.origin);
  try {
    const memory = await recallForRun({ ...input, mcp });
    // A resolution warning already names why no target survived. The generic
    // consequence beside it only repeats the same loss without more action.
    const warnings = memory.warnings.filter(
      (warning) => warning !== noRecallTargetWarning() || mcp.warnings.length === 0,
    );
    return { ...memory, warnings: [...mcp.warnings, ...warnings] };
  } finally {
    await closeMcp(mcp.close);
  }
}

/**
 * The recall a run makes, gated on its version — what both run sites call, so
 * the opt-in check, the query and the way the answer reaches the engine are
 * spelled once. `version` is the version *as bound*, not as widened by
 * discovery (see {@link recallTargets}); `mcp` is the resolve that ran.
 */
export async function recallForRun(input: {
  configuration: AgentConfiguration;
  mcp: Pick<ResolvedMcp, "mcpServers" | "aliasFor" | "callMcpTool">;
  query: string;
  signal?: AbortSignal;
}): Promise<{
  input: Pick<engine.RunAgentInput, "remembered">;
  warnings: string[];
  asked: number;
  failed: number;
}> {
  if (!input.configuration.parameters.memoryRecall) {
    return { input: {}, warnings: [], asked: 0, failed: 0 };
  }
  const result = await recallMemories(input);
  return {
    input: result.remembered ? { remembered: result.remembered } : {},
    warnings: result.warnings,
    asked: result.asked,
    failed: result.failed,
  };
}

/**
 * Ask every bound server that offers `recall`, in parallel, and fold the
 * answers into one block. Never throws for a memory that cannot be read: that
 * is a warning on the run, not the end of it — the answer is worth more than
 * the recollection, the same judgement a lost artifact write makes. A run that
 * was cancelled meanwhile is the one exception, and it propagates as itself.
 */
export async function recallMemories(input: {
  /** The version as bound; only its own servers are asked (see {@link recallTargets}). */
  configuration: Pick<AgentConfiguration, "mcpList"> & Partial<Pick<AgentConfiguration, "parameters">>;
  mcp: Pick<ResolvedMcp, "mcpServers" | "aliasFor" | "callMcpTool">;
  /** The newest user turn as text; nothing to ask with is reported, not asked. */
  query: string;
  signal?: AbortSignal;
}): Promise<RecallResult> {
  const { mcp } = input;
  // `cutCodePoints`, not `slice`: the query goes out as JSON-RPC arguments and
  // a cut through a surrogate pair is not text a server can read.
  const query = cutCodePoints(input.query.trim(), MAX_QUERY_CHARS);
  const declared = recallTargets(mcp, input.configuration);
  if (declared.length === 0) {
    return { warnings: [noRecallTargetWarning()], asked: 0, failed: 0 };
  }
  const policy = input.configuration.parameters?.policy;
  const gated = declared.filter(({ alias }) => policy?.blockedTools?.includes(alias) || policy?.approvalTools?.includes(alias));
  const targets = declared.filter((entry) => !gated.includes(entry));
  const policyWarnings = gated.map(({ server }) => `Automatic memory recall from '${server}' was skipped by the tool policy; approved tools run through the Agent.`);
  if (!targets.length) return { warnings: policyWarnings, asked: 0, failed: 0 };
  if (!query || !mcp.callMcpTool) {
    // A picture-only turn, or a resolve that offered the tools but no way to
    // call them. Said out loud: the version says it recalls, and nothing did.
    return {
      warnings: [
        "Memory recall is on, but this turn carried no text to ask memory with; the run started without a memory.",
      ],
      asked: 0,
      failed: 0,
    };
  }
  const callMcpTool = mcp.callMcpTool;
  const warnings: string[] = [...policyWarnings];
  const sections: string[] = [];
  let failed = 0;
  const startedAt = Date.now();
  const answers = await Promise.all(
    targets.map(async ({ server, alias }) => {
      try {
        const result = await settleWithin(callMcpTool(alias, { query }), input.signal);
        return { server, text: result.text.trim() };
      } catch (error) {
        // A run cancelled mid-recall is not a memory server that failed; the
        // engine reads the abort off the signal, and a warning blaming the
        // server would be yielded ahead of it.
        input.signal?.throwIfAborted();
        return { server, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  for (const answer of answers) {
    if ("error" in answer) {
      failed += 1;
      warnings.push(`Memory recall from '${answer.server}' failed; the run started without it: ${answer.error}`);
      continue;
    }
    // The shared convention for a failed tool call, read the way the trace
    // recorder and the tool manager read it (no trailing space): a memory that
    // itself opens with the word is the price of one convention for every
    // producer, and a small one.
    if (answer.text.startsWith("Error:")) {
      failed += 1;
      warnings.push(
        `Memory recall from '${answer.server}' failed; the run started without it: ${answer.text.slice("Error:".length).trim()}`,
      );
      continue;
    }
    if (answer.text) {
      sections.push(targets.length > 1 ? `From ${answer.server}:\n${answer.text}` : answer.text);
    }
  }
  if (sections.length === 0) {
    return { warnings, asked: targets.length, failed };
  }
  const joined = sections.join("\n\n");
  // Same rule as every other cut here: never through a character.
  const remembered =
    joined.length > MAX_RECALLED_CHARS
      ? `${cutCodePoints(joined, MAX_RECALLED_CHARS)}\n…[recall truncated at ${MAX_RECALLED_CHARS} characters]`
      : joined;
  log.info(
    "memory",
    `recalled ${remembered.length} chars from ${targets.map((t) => t.server).join(", ")} in ${Date.now() - startedAt}ms`,
  );
  return { remembered, warnings, asked: targets.length, failed };
}

/**
 * The call, bounded by the recall's own deadline and by the run's signal.
 *
 * Not `shared/withTimeout`, which knows nothing of a signal: what matters here
 * is that a Stop press ends the wait *now*, ahead of any deadline, and is read
 * back as a cancellation rather than as a memory server that failed. The
 * underlying request is not cancelled — `callMcpTool` owns its own timeout and
 * honours the run's signal itself — only stopped being waited for, and both of
 * its outcomes are handled so a late answer is never an unhandled rejection.
 */
async function settleWithin<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  // Already cancelled: nothing to wait for. Checked before a listener is
  // registered, since `abort` will not fire again.
  signal?.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const settle = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      settle();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Request was cancelled"));
    };
    const timer = setTimeout(() => {
      settle();
      reject(new Error(`no answer within ${RECALL_TIMEOUT_MS / 1000}s`));
    }, RECALL_TIMEOUT_MS);
    unrefTimer(timer);
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        settle();
        resolve(value);
      },
      (error: unknown) => {
        settle();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
