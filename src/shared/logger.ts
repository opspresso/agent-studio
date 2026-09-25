/**
 * The one place this app writes to the console.
 *
 * Every line already carried a `[scope]` prefix by convention, and the
 * convention was the only thing holding: nothing stopped a new one, and none of
 * them said which run they came from. A run makes many calls across many
 * modules, so a line without that is a fact with no context — you can see that
 * an MCP server timed out, and not which of the runs in flight lost its tools.
 *
 * It lives in `shared` because everything above it needs it. `domain` is the one
 * layer that cannot reach even here (it imports nothing from `@/` at all), so
 * its single counter-keeping line stays a bare `console` call — see the
 * single-owner entry in `tests/architecture.test.ts`.
 */

import { currentRunContext } from "./runContext";

/** Subsystem the line belongs to. Free-form, but reuse an existing one. */
export type LogScope =
  | "api"
  | "artifact"
  | "audio-worker"
  | "audit"
  | "authz"
  | "boot"
  | "catalog"
  | "chat"
  | "concurrency"
  | "config"
  | "cost-guard"
  | "db"
  | "engine"
  | "fetch"
  | "image"
  | "managed-mcp"
  | "mcp"
  | "memory"
  | "messaging"
  | "models"
  | "otel"
  | "plugins"
  | "agent"
  | "run"
  | "runDeadline"
  | "settings"
  | "slack"
  | "teams"
  | "telegram"
  | "token"
  | "trace"
  | "trigger"
  | "usage"
  | "version"
  | "workspace-worker";

/**
 * `[scope]` as before, plus the run this happened in when there is one.
 *
 * Appended to the message rather than passed as a structured field so the line
 * stays readable in a plain terminal and greppable by `run=`; a collector that
 * wants structure can parse the suffix.
 */
function prefix(scope: LogScope): string {
  const context = currentRunContext();
  if (!context) {
    return `[${scope}]`;
  }
  const trace = context.traceId ? ` trace=${context.traceId}` : "";
  return `[${scope} run=${context.runId}${trace}]`;
}

export const log = {
  info(scope: LogScope, message: string, ...details: unknown[]): void {
    console.log(`${prefix(scope)} ${message}`, ...details);
  },
  warn(scope: LogScope, message: string, ...details: unknown[]): void {
    console.warn(`${prefix(scope)} ${message}`, ...details);
  },
  error(scope: LogScope, message: string, ...details: unknown[]): void {
    console.error(`${prefix(scope)} ${message}`, ...details);
  },
};
