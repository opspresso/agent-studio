/**
 * Limits on the tool set one run declares to a provider.
 *
 * Here for the same reason the image caps are: this is a bound the *provider*
 * imposes, not one this platform chose. Everything the loop decides for itself —
 * how deep a transfer chain may go, how many turns a run gets, how much tool
 * output one turn may spend, how many calls run at once — belongs beside the
 * mechanism that spends it, in `application/`.
 */

/**
 * Tool definitions one request may carry.
 *
 * Providers cap this and reject the whole request over it — OpenAI's own limit
 * is 128 — so the run fails outright rather than degrading. Losing the tail of
 * the tool list is strictly better than losing the run, and what was dropped is
 * reported. Set below the provider's own number because the engine's builtins
 * are added after the MCP tools are cut, and they need the room.
 */
export const MAX_MCP_TOOLS_PER_RUN = 120;
