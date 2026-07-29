/**
 * The id that ties one run's log lines together.
 *
 * Not the trace id, deliberately. Traces are sampled on the non-agent paths
 * (`TRACE_SAMPLE_RATE`, default 0.1), so using one as the correlation id would
 * leave nine out of ten prompt and image runs with nothing to correlate on —
 * and the runs worth reading logs for are exactly the ones that went wrong,
 * which sampling does not favour. Every run gets a correlation id; a trace, when
 * there is one, is *linked* to it.
 *
 * `AsyncLocalStorage` rather than a threaded parameter: a run is a generator
 * consumed across many awaits, and the code that logs is often four layers below
 * the code that knows which run it is (a repository, an MCP session, a channel).
 * Passing an id to all of them would be a parameter on almost every signature in
 * the codebase.
 */

// `AsyncLocalStorage` is one of the Node builtins the Edge runtime implements,
// so importing it here is safe. `randomUUID` is *not* — and this module is
// reachable from `instrumentation.ts`, which Next compiles for Edge as well as
// Node, so a `node:crypto` import here fails that build and takes down every
// page the middleware runs on. The Web Crypto global is present in all three
// runtimes and needs no import at all.
import { AsyncLocalStorage } from "node:async_hooks";

export interface RunContext {
  /** Stable for the whole run, including its subagent transfers. */
  runId: string;
  /** The run's trace, once one exists. Absent when the run was not sampled. */
  traceId?: string;
}

const storage = new AsyncLocalStorage<RunContext>();

/**
 * Start a correlation scope for the current run, or join the one already open.
 *
 * `enterWith` rather than `run(store, callback)` because the caller is a bracket
 * — `openRun()` … `close()` — not a wrapper it could hand a callback to. It must
 * therefore be called **before the bracket's first await**, or it binds to the
 * bracket's own continuation instead of the caller's and never reaches the run.
 *
 * An existing scope wins. Work started outside a request — a webhook delivery,
 * a Slack event — opens one with the id the operator can already see (the
 * delivery id, the Slack event id) via {@link withRunContext}, because
 * `enterWith` does not survive the generator delegation on those paths. Minting
 * a second id underneath would split one run's lines across two.
 */
export function enterRunContext(): RunContext {
  const existing = storage.getStore();
  if (existing) {
    return existing;
  }
  const context: RunContext = { runId: crypto.randomUUID() };
  storage.enterWith(context);
  return context;
}

/** The current run's context, or undefined outside a run (boot, a plain read). */
export function currentRunContext(): RunContext | undefined {
  return storage.getStore();
}

/**
 * Attach a trace to the current run, so a log line and a trace can be joined.
 * A no-op outside a run, and when a trace was already linked — the first is the
 * run's own; later ones belong to its subagents.
 */
export function linkTrace(traceId: string): void {
  const context = storage.getStore();
  if (context && context.traceId === undefined) {
    context.traceId = traceId;
  }
}

/**
 * Run `fn` inside `context`. The reliable form — unlike `enterWith`, this holds
 * across awaits and generator delegation — so it is what background work uses
 * to open its own scope before handing off to the run.
 */
export function withRunContext<T>(context: RunContext, fn: () => T): T {
  return storage.run(context, fn);
}
