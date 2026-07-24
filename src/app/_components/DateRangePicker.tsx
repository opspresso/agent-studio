"use client";

import { DATE_PRESETS, presetRange, type DateRange } from "@/app/_lib/dateRange";

const inputClass =
  "rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900";

/**
 * Shared From/To date range picker with quick-select preset buttons. Used by the
 * cost dashboard, project usage, and project traces so date search looks and
 * behaves the same everywhere.
 */
export function DateRangePicker({
  value,
  onChange,
  presets = DATE_PRESETS,
}: {
  value: DateRange;
  onChange: (range: DateRange) => void;
  presets?: readonly number[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1 text-sm text-neutral-500">
        From
        <input
          type="date"
          value={value.from}
          max={value.to}
          onChange={(e) => onChange({ ...value, from: e.target.value })}
          className={inputClass}
        />
      </label>
      <label className="flex items-center gap-1 text-sm text-neutral-500">
        To
        <input
          type="date"
          value={value.to}
          min={value.from}
          onChange={(e) => onChange({ ...value, to: e.target.value })}
          className={inputClass}
        />
      </label>
      {presets.length > 0 && (
        <div className="flex gap-1">
          {presets.map((days) => (
            <button
              key={days}
              type="button"
              onClick={() => onChange(presetRange(days))}
              className="rounded-lg border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              {days}d
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
