"use client";

import { useState } from "react";
import type { SubagentRef } from "../../lib/api";

const inputClass =
  "w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-neutral-700";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  step,
  min,
  max,
  placeholder,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  step?: number;
  min?: number;
  max?: number;
  placeholder?: string;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        value={value ?? ""}
        step={step}
        min={min}
        max={max}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        className={inputClass}
      />
    </Field>
  );
}

export interface PickerOption {
  value: string;
  description?: string;
  badge?: string;
}

function matches(option: PickerOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) {
    return true;
  }
  return (
    option.value.toLowerCase().includes(q) ||
    (option.description ?? "").toLowerCase().includes(q)
  );
}

function OptionDropdown<T extends PickerOption>({
  options,
  emptyText,
  onPick,
}: {
  options: T[];
  emptyText: string;
  onPick: (option: T) => void;
}) {
  return (
    <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
      {options.length === 0 ? (
        <p className="px-3 py-2 text-xs text-neutral-400">{emptyText}</p>
      ) : (
        options.map((option) => (
          <button
            key={`${option.badge ?? ""}:${option.value}`}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(option)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <span className="shrink-0">{option.value}</span>
            {option.badge && (
              <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-800">
                {option.badge}
              </span>
            )}
            {option.description && (
              <span className="min-w-0 truncate text-xs text-neutral-400">{option.description}</span>
            )}
          </button>
        ))
      )}
    </div>
  );
}

/** Chip list fed by registered options: type to filter, pick to add. */
export function SearchSelectInput({
  label,
  values,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  options: PickerOption[];
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);

  const available = options.filter((o) => !values.includes(o.value) && matches(o, draft));

  function add(value: string) {
    if (!values.includes(value)) {
      onChange([...values, value]);
    }
    setDraft("");
  }

  return (
    <Field label={label}>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <span
            key={value}
            className="inline-flex items-center gap-1 rounded bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800"
          >
            {value}
            <button
              type="button"
              onClick={() => onChange(values.filter((v) => v !== value))}
              className="text-neutral-400 hover:text-red-500"
              aria-label={`Remove ${value}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="relative mt-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (available[0]) {
                add(available[0].value);
              }
            }
            if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={placeholder}
          className={inputClass}
        />
        {open && (
          <OptionDropdown
            options={available}
            emptyText="No matching entries."
            onPick={(option) => add(option.value)}
          />
        )}
      </div>
    </Field>
  );
}

/** Subagent picker over registered sources: projects (local) and external agents (remote). */
export function SubagentInput({
  values,
  onChange,
  options,
}: {
  values: SubagentRef[];
  onChange: (values: SubagentRef[]) => void;
  options: Array<PickerOption & { type: "local" | "remote" }>;
}) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);

  const available = options.filter(
    (o) => !values.some((v) => v.name === o.value) && matches(o, draft),
  );

  function add(option: PickerOption & { type: "local" | "remote" }) {
    if (!values.some((v) => v.name === option.value)) {
      onChange([...values, { name: option.value, type: option.type }]);
    }
    setDraft("");
  }

  return (
    <Field label="Subagents">
      <div className="space-y-1.5">
        {values.map((ref) => (
          <div
            key={ref.name}
            className="flex items-center justify-between rounded bg-neutral-100 px-2 py-1 text-xs dark:bg-neutral-800"
          >
            <span>
              {ref.name} <span className="text-neutral-400">({ref.type})</span>
            </span>
            <button
              type="button"
              onClick={() => onChange(values.filter((v) => v.name !== ref.name))}
              className="text-neutral-400 hover:text-red-500"
              aria-label={`Remove ${ref.name}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="relative mt-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (available[0]) {
                add(available[0]);
              }
            }
            if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder="Search projects and external agents"
          className={inputClass}
        />
        {open && (
          <OptionDropdown options={available} emptyText="No matching agents." onPick={add} />
        )}
      </div>
    </Field>
  );
}

export { inputClass };
