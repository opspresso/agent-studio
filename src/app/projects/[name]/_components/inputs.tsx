"use client";

import { useState } from "react";
import type { McpBinding, SubagentRef } from "../../lib/api";
import { overridesToRows, rowsToOverrides, type OverrideRow } from "./mcpOverrides";

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

/**
 * Per-binding header overrides. A value replaces or adds a header on top of the
 * MCP server's registry headers; "remove" drops a registry default for this
 * version only. Values are stored encrypted, so existing ones arrive masked —
 * leaving a masked value keeps the stored secret.
 */
function OverrideEditor({
  rows,
  onChange,
}: {
  rows: OverrideRow[];
  onChange: (rows: OverrideRow[]) => void;
}) {
  function update(index: number, patch: Partial<OverrideRow>) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  return (
    <div className="space-y-1.5 border-t border-neutral-200 px-2 py-2 dark:border-neutral-700">
      {rows.length === 0 && (
        <p className="text-xs text-neutral-400">
          No overrides — this version uses the server&apos;s registry headers.
        </p>
      )}
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <input
            value={row.key}
            onChange={(e) => update(index, { key: e.target.value })}
            placeholder="Header-Name"
            className="w-2/5 rounded border border-neutral-300 bg-transparent px-2 py-1 text-xs focus:border-brand focus:outline-none dark:border-neutral-700"
          />
          <input
            value={row.remove ? "" : row.value}
            onChange={(e) => update(index, { value: e.target.value })}
            disabled={row.remove}
            placeholder={row.remove ? "(removed)" : "value"}
            className="flex-1 rounded border border-neutral-300 bg-transparent px-2 py-1 text-xs focus:border-brand focus:outline-none disabled:opacity-50 dark:border-neutral-700"
          />
          <label
            className="flex shrink-0 items-center gap-1 text-xs text-neutral-500"
            title="Drop this header from the registry defaults for this version"
          >
            <input
              type="checkbox"
              checked={row.remove}
              onChange={(e) => update(index, { remove: e.target.checked })}
            />
            remove
          </label>
          <button
            type="button"
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
            aria-label="Delete override row"
            className="rounded border border-neutral-300 px-1.5 text-xs text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, { key: "", value: "", remove: false }])}
        className="text-xs text-brand hover:text-brand-strong"
      >
        + Add header override
      </button>
    </div>
  );
}

/**
 * MCP server picker. Each bound server may redefine the registry's headers for
 * this version only; the URL always stays the registry's.
 */
export function McpBindingInput({
  values,
  onChange,
  options,
}: {
  values: McpBinding[];
  onChange: (values: McpBinding[]) => void;
  options: PickerOption[];
}) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);

  const available = options.filter(
    (o) => !values.some((v) => v.name === o.value) && matches(o, draft),
  );

  function add(value: string) {
    if (!values.some((v) => v.name === value)) {
      onChange([...values, { name: value }]);
    }
    setDraft("");
  }

  function setHeaders(name: string, rows: OverrideRow[]) {
    onChange(
      values.map((binding) => {
        if (binding.name !== name) {
          return binding;
        }
        const headers = rowsToOverrides(rows);
        return headers ? { name, headers } : { name };
      }),
    );
  }

  return (
    <Field label="MCP servers">
      <div className="space-y-1.5">
        {values.map((binding) => {
          const count = Object.keys(binding.headers ?? {}).length;
          const isOpen = expanded.includes(binding.name);
          return (
            <div
              key={binding.name}
              className="rounded bg-neutral-100 text-xs dark:bg-neutral-800"
            >
              <div className="flex items-center justify-between px-2 py-1">
                <span>
                  {binding.name}
                  {count > 0 && (
                    <span className="ml-1 text-neutral-400">
                      ({count} header override{count === 1 ? "" : "s"})
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded(
                        isOpen
                          ? expanded.filter((n) => n !== binding.name)
                          : [...expanded, binding.name],
                      )
                    }
                    className="text-neutral-500 hover:text-brand"
                  >
                    {isOpen ? "Hide headers" : "Headers"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange(values.filter((v) => v.name !== binding.name))}
                    className="text-neutral-400 hover:text-red-500"
                    aria-label={`Remove ${binding.name}`}
                  >
                    ×
                  </button>
                </span>
              </div>
              {isOpen && (
                <OverrideEditor
                  rows={overridesToRows(binding.headers)}
                  onChange={(rows) => setHeaders(binding.name, rows)}
                />
              )}
            </div>
          );
        })}
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
          placeholder="Search registered MCP servers"
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
