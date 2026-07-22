"use client";

export interface HeaderRow {
  key: string;
  value: string;
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
 * masked (length-preserving asterisks); leaving a value masked keeps the stored secret, while
 * typing a new value replaces it.
 */
export function HeaderRowsEditor({
  rows,
  onChange,
}: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
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
      <span className="text-sm font-medium">Headers</span>
      {rows.length === 0 && (
        <p className="text-xs text-neutral-400">No headers. Add one if the endpoint needs auth.</p>
      )}
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            value={row.key}
            onChange={(e) => update(index, { key: e.target.value })}
            placeholder="Header-Name"
            className="w-2/5 rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-neutral-700"
          />
          <input
            value={row.value}
            onChange={(e) => update(index, { value: e.target.value })}
            placeholder="value"
            className="flex-1 rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-neutral-700"
          />
          <span
            title="Stored encrypted at rest"
            className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-400"
          >
            secret
          </span>
          <button
            type="button"
            onClick={() => remove(index)}
            aria-label="Remove header"
            className="rounded-md border border-neutral-300 px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="text-sm text-brand hover:text-brand-strong"
      >
        + Add header
      </button>
    </div>
  );
}
