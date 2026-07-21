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

/** Chip list with free-text add. Used for MCP servers and skills. */
export function TagInput({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");

  function add() {
    const value = draft.trim();
    if (value && !values.includes(value)) {
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
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        placeholder={placeholder}
        className={`${inputClass} mt-1.5`}
      />
    </Field>
  );
}

/** Subagent list editor: name + local/remote type. */
export function SubagentInput({
  values,
  onChange,
}: {
  values: SubagentRef[];
  onChange: (values: SubagentRef[]) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"local" | "remote">("local");

  function add() {
    const trimmed = name.trim();
    if (trimmed && !values.some((v) => v.name === trimmed)) {
      onChange([...values, { name: trimmed, type }]);
    }
    setName("");
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
      <div className="mt-1.5 flex gap-1.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="agent name"
          className={inputClass}
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value as "local" | "remote")}
          className="rounded-md border border-neutral-300 bg-transparent px-2 text-sm dark:border-neutral-700"
        >
          <option value="local">local</option>
          <option value="remote">remote</option>
        </select>
        <button
          type="button"
          onClick={add}
          className="rounded-md border border-neutral-300 px-3 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          Add
        </button>
      </div>
    </Field>
  );
}

export { inputClass };
