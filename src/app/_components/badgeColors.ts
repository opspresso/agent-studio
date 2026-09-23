import type { MemberTier } from "@/domain/member/tiers";
import type { McpRuntime } from "@/domain/mcp/types";
import type { ProjectType } from "@/domain/project/types";

/**
 * What a badge's colour means.
 *
 * Colour is the only thing separating a badge that says "this is on" from one
 * that says "this needs attention", and the theme gives every badge a gray
 * default — so a badge nobody coloured silently joins the "off" vocabulary. Half
 * of them had: `managed`, `OAuth`, `2 headers`, `no credential`, `SSE`
 * all rendered identically to `disabled`, and the three sections that *did*
 * colour their state each spelled `on ? "teal" : "gray"` out again locally.
 *
 * Two vocabularies, and the split is the point:
 *
 * `BADGE` is **state** — how the thing is doing. Five colours, no more, so a
 * reader can learn them once.
 *
 * The `*_COLOR` maps are **kind** — what the thing is. They draw from the
 * colours `BADGE` does not use, because a reader who has learned that teal means
 * "on" must not meet a teal badge that only means "llm". The two exceptions
 * below name themselves: a kind may borrow `BADGE.neutral` for its unmarked
 * case, and `GET` borrows `BADGE.on` because "safe to call" is the reading.
 * Kinds may reuse a colour across pages; they may not collide within one.
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

/** The state pair, for the enabled/disabled badges that were each writing it out. */
export function stateColor(on: boolean): string {
  return on ? BADGE.on : BADGE.neutral;
}

/** What a project runs: a single prompt, a tool loop, or an image model. */
export const PROJECT_TYPE_COLOR: Record<ProjectType, string> = {
  agent: "violet",
};

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

/** Local project vs. registered external agent, in the subagent picker. */
export const SUBAGENT_KIND_COLOR: Record<"local" | "remote", string> = {
  local: "violet",
  remote: "indigo",
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
