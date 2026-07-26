"use client";

import type { McpTool } from "@/domain/mcp/types";
import { useEffect, useId, useState } from "react";
import type { McpBinding, SubagentRef } from "../../lib/api";
import { listProjectMcpTools } from "../../lib/api";
import { getMcp } from "@/app/tools/api";
import { overridesToRows, rowsToOverrides, type OverrideRow } from "./mcpOverrides";
import { McpBindingSettings } from "./McpBindingSettings";
import { Badge } from "@/app/_components/Badge";
import { HeaderRowsEditor } from "@/app/_components/HeaderRows";
import { controlClass } from "@/app/_components/formStyles";

const inputClass = `w-full ${controlClass}`;

/**
 * A named group of controls.
 *
 * Deliberately NOT a `<label>`. A label with no `for` binds to the first
 * labelable element inside it, and the spec then makes hovering the label hover
 * that control and clicking the label *activate* it. With several controls in
 * one field that is silently destructive: clicking the words "MCP servers"
 * opened the first server's settings, and clicking "Subagents" removed the first
 * subagent. `aria-labelledby` names the group without binding it to one member.
 *
 * Use {@link LabeledField} when the field really does wrap a single control and
 * click-to-focus is worth having.
 */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="block">
      <span id={id} className="text-sm font-medium">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/**
 * A label bound to exactly one control. Only for fields whose content is a
 * single input — anything else belongs in {@link Field}.
 */
export function LabeledField({ label, children }: { label: string; children: React.ReactNode }) {
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
    <LabeledField label={label}>
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
    </LabeledField>
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
              <Badge className="shrink-0">{option.badge}</Badge>
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
/**
 * Pick which of a server's tools this version offers. The list is fetched from
 * the server itself (the same probe the registry's "Test connection" uses), so
 * the choices are what the model would actually be given. No selection means
 * every tool, which is what a binding meant before it could be narrowed.
 */
function ToolSelector({
  selected,
  onChange,
  load,
}: {
  selected: string[] | undefined;
  onChange: (tools: string[]) => void;
  load: () => Promise<McpTool[]>;
}) {
  const [tools, setTools] = useState<McpTool[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (fetched) => {
        if (!cancelled) {
          setTools(fetched);
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Could not reach this server");
        }
      },
    );
    return () => {
      cancelled = true;
    };
    // The loader closes over a stable binding name; refetching per render would
    // hammer the MCP server on every keystroke elsewhere in the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    // Deliberately not "leaving this unset offers every tool": a run that cannot
    // reach or authorize a server drops it whole and offers *none* of its tools,
    // so advising an empty selection here would advise the opposite outcome.
    return (
      <p className="px-2 pb-2 text-neutral-500">
        {error}
        {" — a run would offer none of this server’s tools until it answers."}
      </p>
    );
  }
  if (!tools) {
    return <p className="px-2 pb-2 text-neutral-500">Loading tools…</p>;
  }
  if (tools.length === 0) {
    return <p className="px-2 pb-2 text-neutral-500">This server exposes no tools.</p>;
  }

  const chosen = selected ?? [];
  // A stored name the server no longer exposes stays listed so it can be cleared.
  const missing = chosen.filter((name) => !tools.some((tool) => tool.name === name));
  return (
    <div className="space-y-1 px-2 pb-2">
      <p className="text-neutral-500">
        {chosen.length === 0
          ? "Every tool is offered. Select some to narrow what the model sees."
          : `${chosen.length} of ${tools.length} tools offered.`}
      </p>
      {[...tools, ...missing.map((name) => ({ name, description: "no longer exposed" }))].map(
        (tool) => (
          <label key={tool.name} className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={chosen.includes(tool.name)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...chosen, tool.name]
                    : chosen.filter((name) => name !== tool.name),
                )
              }
              className="mt-0.5"
            />
            <span>
              <span className="font-mono">{tool.name}</span>
              {tool.description && (
                <span className="ml-1 text-neutral-400">{tool.description}</span>
              )}
            </span>
          </label>
        ),
      )}
    </div>
  );
}

function OverrideEditor({
  rows,
  onChange,
  inherited,
}: {
  rows: OverrideRow[];
  onChange: (rows: OverrideRow[]) => void;
  /** The registry entry's own headers, masked, that this version layers over. */
  inherited: Record<string, string>;
}) {
  // Header names are case-insensitive, and so is the merge at dispatch, so a row
  // for `authorization` already covers an inherited `Authorization`.
  const overridden = new Set(rows.map((row) => row.key.trim().toLowerCase()).filter(Boolean));
  const inheritedNames = Object.keys(inherited);

  return (
    <div className="space-y-2 border-t border-neutral-200 px-2 py-2 dark:border-neutral-700">
      {inheritedNames.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-neutral-400">
            Inherited from the registry entry — select one to override it here.
          </p>
          {inheritedNames.map((name) => {
            const taken = overridden.has(name.toLowerCase());
            return (
              <button
                key={name}
                type="button"
                disabled={taken}
                onClick={() => onChange([...rows, { key: name, value: "", remove: false }])}
                className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs text-neutral-500 hover:bg-neutral-100 disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-neutral-800"
              >
                <span className="font-mono">{name}</span>
                <span className="truncate font-mono text-neutral-400">{inherited[name]}</span>
                {taken && <span className="ml-auto shrink-0 text-neutral-400">overridden</span>}
              </button>
            );
          })}
        </div>
      )}
      <HeaderRowsEditor
        rows={rows}
        onChange={onChange}
        caption={null}
        addLabel="+ Add header override"
        allowRemove
        emptyHint={
          inheritedNames.length === 0
            ? "No overrides, and this server's registry entry defines no headers either."
            : "No overrides — this version uses the headers above unchanged."
        }
      />
    </div>
  );
}

/**
 * MCP server picker. Each bound server may redefine the registry's headers for
 * this version only; the URL always stays the registry's.
 */
export function McpBindingInput({
  projectName,
  values,
  onChange,
  options,
}: {
  projectName: string;
  values: McpBinding[];
  onChange: (values: McpBinding[]) => void;
  options: PickerOption[];
}) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  /** Which binding's settings modal is open; one at a time. */
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  /**
   * Rows being edited, per server. The saved binding cannot hold them: a row
   * whose header name is still blank has no place in an override map, so
   * deriving rows from the binding would delete a freshly added row before it
   * could be typed into. Same split as the registry header editor, which keeps
   * its rows in the form and only projects them on submit.
   */
  const [rowsByName, setRowsByName] = useState<Record<string, OverrideRow[]>>({});

  /**
   * The registry entry's own headers, masked, for the server whose dialog is
   * open. Without them an owner has to know a header's name by heart before
   * they can override it — the editor gave no way to see what it was layering
   * over.
   */
  const [inherited, setInherited] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!settingsFor) {
      setInherited({});
      return;
    }
    let cancelled = false;
    getMcp(settingsFor).then(
      (entry) => {
        if (!cancelled) {
          setInherited(entry.headers ?? {});
        }
      },
      () => {
        // The dialog still works without them; the connection card below reports
        // whatever went wrong with the same read.
        if (!cancelled) {
          setInherited({});
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [settingsFor]);

  const available = options.filter(
    (o) => !values.some((v) => v.name === o.value) && matches(o, draft),
  );

  function add(value: string) {
    if (!values.some((v) => v.name === value)) {
      onChange([...values, { name: value }]);
    }
    setDraft("");
  }

  function remove(name: string) {
    onChange(values.filter((v) => v.name !== name));
    setRowsByName(({ [name]: _dropped, ...rest }) => rest);
    setSettingsFor((current) => (current === name ? null : current));
  }

  /** An empty selection is stored as "all tools", the shape a binding had before. */
  function setTools(name: string, tools: string[]) {
    onChange(
      values.map((binding) => {
        if (binding.name !== name) {
          return binding;
        }
        const { tools: _previous, ...rest } = binding;
        return tools.length > 0 ? { ...rest, tools } : rest;
      }),
    );
  }

  function rowsFor(binding: McpBinding): OverrideRow[] {
    return rowsByName[binding.name] ?? overridesToRows(binding.headers);
  }

  function setRows(name: string, rows: OverrideRow[]) {
    setRowsByName((prev) => ({ ...prev, [name]: rows }));
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
                  <span className="ml-1 text-neutral-400">
                    ({binding.tools?.length ? `${binding.tools.length} tools` : "all tools"})
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSettingsFor(binding.name)}
                    className="text-neutral-500 hover:text-brand"
                  >
                    Settings
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(binding.name)}
                    className="text-neutral-400 hover:text-red-500"
                    aria-label={`Remove ${binding.name}`}
                  >
                    ×
                  </button>
                </span>
              </div>
            </div>
          );
        })}
        {settingsFor && (
          <McpBindingSettings
            projectName={projectName}
            serverName={settingsFor}
            onClose={() => setSettingsFor(null)}
            tools={
              <ToolSelector
                selected={values.find((v) => v.name === settingsFor)?.tools}
                onChange={(tools) => setTools(settingsFor, tools)}
                load={() =>
                  listProjectMcpTools(
                    projectName,
                    settingsFor,
                    values.find((v) => v.name === settingsFor)?.headers,
                  )
                }
              />
            }
            headers={
              <OverrideEditor
                rows={rowsFor(values.find((v) => v.name === settingsFor) ?? { name: settingsFor })}
                onChange={(rows) => setRows(settingsFor, rows)}
                inherited={inherited}
              />
            }
          />
        )}
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
