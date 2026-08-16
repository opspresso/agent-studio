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

import type * as engine from "@/application/llm/engine";
import type { ResolvedMcp } from "./mcpTools";
import { log } from "@/shared/logger";
import { unrefTimer } from "@/shared/unrefTimer";

/**
 * The tool a memory server is expected to offer: `recall` taking `{ query }`
 * and answering in text. mcp-memory's contract; any server that spells it the
 * same primes the same way. A convention rather than a per-version setting,
 * because the setting would only ever name this string.
 */
export const RECALL_TOOL_NAME = "recall";

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
}

/**
 * Ask every bound server that offers `recall`, in parallel, and fold the
 * answers into one block. Never throws: a memory that cannot be read is a
 * warning on the run, not the end of it — the answer is worth more than the
 * recollection, the same judgement a lost artifact write makes.
 */
export async function recallMemories(input: {
  mcp: Pick<ResolvedMcp, "mcpServers" | "aliasFor" | "callMcpTool">;
  /** The newest user turn as text; nothing to ask with means nothing is asked. */
  query: string;
  signal?: AbortSignal;
}): Promise<RecallResult> {
  const { mcp } = input;
  const query = input.query.trim().slice(0, MAX_QUERY_CHARS);
  const targets = mcp.mcpServers.flatMap((server) => {
    const alias = mcp.aliasFor?.(server.name, RECALL_TOOL_NAME);
    return alias ? [{ server: server.name, alias }] : [];
  });
  if (targets.length === 0) {
    return {
      warnings: [
        `Memory recall is on, but no bound MCP server offers a '${RECALL_TOOL_NAME}' tool; the run started without a memory.`,
      ],
    };
  }
  if (!query || !mcp.callMcpTool) {
    return { warnings: [] };
  }
  const callMcpTool = mcp.callMcpTool;
  const warnings: string[] = [];
  const sections: string[] = [];
  const answers = await Promise.all(
    targets.map(async ({ server, alias }) => {
      try {
        const result = await withTimeout(callMcpTool(alias, { query }), input.signal);
        return { server, text: result.text.trim() };
      } catch (error) {
        return { server, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  for (const answer of answers) {
    if ("error" in answer) {
      warnings.push(`Memory recall from '${answer.server}' failed; the run started without it: ${answer.error}`);
      continue;
    }
    // The shared convention for a failed tool call — see the engine's loop.
    if (answer.text.startsWith("Error: ")) {
      warnings.push(`Memory recall from '${answer.server}' failed; the run started without it: ${answer.text.slice("Error: ".length)}`);
      continue;
    }
    if (answer.text) {
      sections.push(targets.length > 1 ? `From ${answer.server}:\n${answer.text}` : answer.text);
    }
  }
  if (sections.length === 0) {
    return { warnings };
  }
  const joined = sections.join("\n\n");
  const remembered =
    joined.length > MAX_RECALLED_CHARS
      ? `${joined.slice(0, MAX_RECALLED_CHARS)}\n…[recall truncated at ${MAX_RECALLED_CHARS} characters]`
      : joined;
  log.info("memory", `recalled ${remembered.length} chars from ${targets.map((t) => t.server).join(", ")}`);
  return { remembered, warnings };
}

async function withTimeout<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no answer within ${RECALL_TIMEOUT_MS / 1000}s`)),
      RECALL_TIMEOUT_MS,
    );
    unrefTimer(timer);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Request was cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** What the engine is handed: the recalled text, or nothing. */
export function rememberedInput(result: RecallResult): Pick<engine.RunAgentInput, "remembered"> {
  return result.remembered ? { remembered: result.remembered } : {};
}
