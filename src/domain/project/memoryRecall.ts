import type { McpBinding } from "./types";

/**
 * The tool a memory server is expected to offer: `recall` taking `{ query }`
 * and answering in text. mcp-memory's contract; any server that spells it the
 * same primes the same way. A convention rather than a per-version setting,
 * because the setting would only ever name this string.
 *
 * Domain rather than the run site that asks it (`application/execution/
 * memoryRecall.ts`), because the version editor reads the same name to say,
 * before a run, that nothing bound could answer — and a second spelling there
 * would be the copy the single-owner rule exists to prevent.
 */
export const RECALL_TOOL_NAME = "recall";

/**
 * Whether a version's bindings could offer `recall` at all — what can be told
 * from the bindings alone, before any server is asked. `false` is certain:
 * either nothing is bound, or every binding narrows its tools to a list that
 * leaves `recall` out, so no run of this version will ever have it. `true` is
 * only "not ruled out": a binding that offers all its tools may or may not have
 * one, and only discovery says — the prompt preview asks it.
 */
export function bindingsMayOfferRecall(mcpList: readonly McpBinding[]): boolean {
  return mcpList.some((binding) => !binding.tools?.length || binding.tools.includes(RECALL_TOOL_NAME));
}
