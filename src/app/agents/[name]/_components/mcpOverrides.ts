/**
 * Encoding between an Agent's MCP header overrides and the editable rows the
 * binding editor renders. Kept free of React so the mapping — the one place a
 * UI bug could silently turn a removal into an empty header, or drop an
 * override entirely — is directly testable.
 */

import type { McpBinding } from "@/domain/agent/types";
import type { HeaderRow } from "@/app/_components/HeaderRows";

/**
 * A header row that can also carry the `null` marker — drop this header from the
 * registry defaults. The same row the shared editor renders; only the encoding
 * below is specific to a binding.
 */
export type OverrideRow = HeaderRow;

export function overridesToRows(headers: McpBinding["headers"]): OverrideRow[] {
  return Object.entries(headers ?? {}).map(([key, value]) =>
    value === null ? { key, value: "", remove: true } : { key, value, storedValue: value, remove: false },
  );
}

/**
 * Collapse rows back into an override map. Rows with a blank header name are
 * dropped (they are half-typed), and a binding with nothing left returns
 * `undefined` so it is stored without a `headers` field at all. `fromEntries`
 * preserves own keys such as `__proto__` in the request JSON.
 */
export function rowsToOverrides(rows: OverrideRow[]): McpBinding["headers"] {
  const entries = rows.flatMap((row) => {
    const key = row.key.trim();
    return key ? [[key, row.remove === true ? null : row.value] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
