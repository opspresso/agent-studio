/**
 * Encoding between a version's MCP header overrides and the editable rows the
 * binding editor renders. Kept free of React so the mapping — the one place a
 * UI bug could silently turn a removal into an empty header, or drop an
 * override entirely — is directly testable.
 */

import type { McpBinding } from "@/domain/project/types";

export interface OverrideRow {
  key: string;
  value: string;
  /** Encodes the `null` marker: drop this header from the registry defaults. */
  remove: boolean;
}

export function overridesToRows(headers: McpBinding["headers"]): OverrideRow[] {
  return Object.entries(headers ?? {}).map(([key, value]) =>
    value === null ? { key, value: "", remove: true } : { key, value, remove: false },
  );
}

/**
 * Collapse rows back into an override map. Rows with a blank header name are
 * dropped (they are half-typed), and a binding with nothing left returns
 * `undefined` so it is stored without a `headers` field at all.
 */
export function rowsToOverrides(rows: OverrideRow[]): McpBinding["headers"] {
  const headers: Record<string, string | null> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) {
      headers[key] = row.remove ? null : row.value;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}
