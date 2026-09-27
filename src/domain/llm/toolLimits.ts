/**
 * Limits on the tool set one run declares to a provider.
 *
 * Here for the same reason the image caps are: this is a bound the *provider*
 * imposes, not one this platform chose. Everything the loop decides for itself —
 * how deep a transfer chain may go, how many turns a run gets, how much tool
 * output one turn may spend, how many calls run at once — belongs beside the
 * mechanism that spends it, in `application/`.
 */

import { BUILTIN_TOOL_NAMES } from "./toolNames";

/**
 * Tool definitions one request may carry in all — the provider's own 128.
 * {@link MAX_MCP_TOOLS_PER_RUN} reserves room for builtins.
 */
export const MAX_TOOLS_PER_REQUEST = 128;

/**
 * Reserve every builtin name within the provider tool cap before adding MCP
 * tools. The bound derives from BUILTIN_TOOL_NAMES.length and is shared by
 * preparation and validation; final assembly also bounds delegated tools.
 */
export const MAX_MCP_TOOLS_PER_RUN = MAX_TOOLS_PER_REQUEST - BUILTIN_TOOL_NAMES.length;
