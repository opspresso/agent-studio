"use client";
import { controlClass } from "./formStyles";

export interface HeaderRow {
  key: string;
  value: string;
  /**
   * Only meaningful where the rows layer over defaults (see `allowRemove`):
   * drop the inherited header rather than replace it. Registry headers have
   * nothing to drop, so their rows leave it unset.
   */
  remove?: boolean;
}

export function recordToRows(record: Record<string, string>): HeaderRow[] {
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

export function rowsToRecord(rows: HeaderRow[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const { key, value } of rows) {
    const trimmed = key.trim();
    if (trimmed) {
      record[trimmed] = value;
    }
  }
  return record;
}

/**
 * Editable key/value header rows. Every header value is stored encrypted at
 * rest, so each row is flagged as a secret. On edit, existing values arrive
 * masked (length-preserving; 9–20 chars reveal 2 at each end, 21+ reveal 4); leaving a value
 * masked keeps the stored secret, while typing a new value replaces it.
 *
 * The one owner of that contract. A second copy of this editor grew inside the
 * version binding form and had already drifted in styling; the only real
 * difference was `allowRemove`, so that is a prop rather than another component.
 */
export function HeaderRowsEditor({
  rows,
  onChange,
  emptyHint = "No headers. Add one if the server needs auth.",
  caption = "Headers",
  addLabel = "+ Add header",
  allowRemove = false,
}: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  emptyHint?: string;
  /** `null` where the surrounding section already names these rows. */
  caption?: string | null;
  addLabel?: string;
  /** Offer "remove", for rows that layer over a set of inherited headers. */
  allowRemove?: boolean;
}) {
  function update(index: number, patch: Partial<HeaderRow>) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }
  function remove(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }
  function add() {
    onChange([...rows, { key: "", value: "" }]);
  }

  return (
    <div className="space-y-2">
      {caption !== null && <span className="text-sm font-medium">{caption}</span>}
      {rows.length === 0 && <p className="text-xs text-neutral-400">{emptyHint}</p>}
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            value={row.key}
            onChange={(e) => update(index, { key: e.target.value })}
            placeholder="Header-Name"
            className={`w-2/5 ${controlClass}`}
          />
          <input
            value={row.remove ? "" : row.value}
            onChange={(e) => update(index, { value: e.target.value })}
            disabled={row.remove === true}
            placeholder={row.remove ? "(removed)" : "value"}
            className={`flex-1 ${controlClass} disabled:opacity-50`}
          />
          {allowRemove ? (
            <label
              className="flex shrink-0 items-center gap-1 text-xs text-neutral-500"
              title="Drop this header from the inherited defaults"
            >
              <input
                type="checkbox"
                checked={row.remove === true}
                onChange={(e) => update(index, { remove: e.target.checked })}
              />
              remove
            </label>
          ) : (
            <span
              title="Stored encrypted at rest"
              className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-400"
            >
              secret
            </span>
          )}
          <button
            type="button"
            onClick={() => remove(index)}
            aria-label="Delete header row"
            className="rounded-md border border-neutral-300 px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            ✕
          </button>
        </div>
      ))}
      <button type="button" onClick={add} className="text-sm text-brand hover:text-brand-strong">
        {addLabel}
      </button>
    </div>
  );
}
