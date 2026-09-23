import type { MemberTier } from "@/domain/member/tiers";
import type { McpRuntime } from "@/domain/mcp/types";

/**
 * What a badge's colour means.
 *
 * `BADGE` colours describe state: enabled, neutral, attention, broken, owned.
 * The `*_COLOR` maps describe kinds and avoid state colours where the same
 * page could confuse type with status. `GET` uses the enabled colour to signal
 * a read-only method; unmarked kinds may use neutral.
 */
export const BADGE = {
  /** On, connected, healthy — and, for an HTTP method, safe to call. */
  on: "teal",
  /** Off, absent, or nothing to say. The theme default. */
  neutral: "gray",
  /** Worth a second look: a stored secret, or a credential that is missing. */
  attention: "yellow",
  /** Broken. */
  broken: "red",
  /** Belongs to this viewer, this project, or this deployment. */
  owned: "brand",
} as const;

/** The shared enabled/disabled state pair. */
export function stateColor(on: boolean): string {
  return on ? BADGE.on : BADGE.neutral;
}

/** Whether this studio runs the MCP server itself. `remote` is the unmarked case. */
export const MCP_RUNTIME_COLOR: Record<McpRuntime, string> = {
  managed: "grape",
  remote: BADGE.neutral,
};

/**
 * The plugin a synced entry came from — a kind, shown on skills and tools.
 * Blue collides with nothing on those pages (`managed` is grape, credentials
 * teal/yellow), and its other use (`POST`) never shares a page with these.
 */
export const PLUGIN_COLOR = "blue";

/** A member's tier — a kind, not a state. Shown on the profile page. */
export const MEMBER_TIER_COLOR: Record<MemberTier, string> = {
  admin: "grape",
  member: "blue",
  guest: "cyan",
};

/** Green reads "safe to call", blue "writes something" — the usual convention. */
export const HTTP_METHOD_COLOR: Record<"GET" | "POST", string> = {
  GET: BADGE.on,
  POST: "blue",
};

/** An endpoint that streams, marked next to its method. */
export const STREAMING_COLOR = "violet";

/** A subagent, wherever a run's path is drawn. */
export const SUBAGENT_COLOR = "violet";
