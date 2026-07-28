"use client";

import type { McpTool } from "@/domain/mcp/types";
import { useEffect, useState } from "react";
import {
  ActionIcon,
  Autocomplete,
  Badge,
  Anchor,
  Checkbox,
  Group,
  Input,
  NumberInput,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import type { McpBinding, SubagentRef } from "../../lib/api";
import { listProjectMcpTools } from "../../lib/api";
import { getMcp } from "@/app/tools/api";
import { overridesToRows, rowsToOverrides, type OverrideRow } from "./mcpOverrides";
import { McpBindingSettings, type VersionSave } from "./McpBindingSettings";
import { HeaderRowsEditor } from "@/app/_components/HeaderRows";

/**
 * A named group of controls.
 *
 * Deliberately NOT a `<label>`. A label with no `for` binds to the first
 * labelable element inside it, and the spec then makes hovering the label hover
 * that control and clicking the label *activate* it. With several controls in
 * one field that is silently destructive: clicking the words "MCP servers"
 * opened the first server's settings, and clicking "Subagents" removed the first
 * subagent. `labelElement="div"` keeps `Input.Wrapper`'s caption from becoming
 * that binding label.
 *
 * Use {@link LabeledField} when the field really does wrap a single control and
 * click-to-focus is worth having.
 */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Input.Wrapper label={label} labelElement="div">
      <div style={{ marginTop: 4 }}>{children}</div>
    </Input.Wrapper>
  );
}

/**
 * A label bound to exactly one control. Only for fields whose content is a
 * single input — anything else belongs in {@link Field}.
 */
export function LabeledField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Input.Wrapper label={label}>
      <div style={{ marginTop: 4 }}>{children}</div>
    </Input.Wrapper>
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
    <NumberInput
      label={label}
      value={value ?? ""}
      step={step}
      min={min}
      max={max}
      placeholder={placeholder}
      onChange={(next) => onChange(next === "" ? undefined : Number(next))}
    />
  );
}

export interface PickerOption {
  value: string;
  description?: string;
  badge?: string;
  /** Colour for {@link badge}; from `badgeColors`, so the picker never picks one. */
  badgeColor?: string;
}

/** Removable chip for a picked value. */
function PickedChip({
  label,
  suffix,
  onRemove,
  action,
}: {
  label: string;
  suffix?: React.ReactNode;
  onRemove: () => void;
  action?: React.ReactNode;
}) {
  return (
    <Group
      justify="space-between"
      gap="xs"
      wrap="nowrap"
      px="xs"
      py={4}
      style={{
        borderRadius: "var(--mantine-radius-sm)",
        backgroundColor: "var(--mantine-color-default-hover)",
      }}
    >
      <Text fz="xs" truncate>
        {label}
        {suffix}
      </Text>
      <Group gap="xs" wrap="nowrap">
        {action}
        <ActionIcon size="xs" variant="subtle" onClick={onRemove} aria-label={`Remove ${label}`}>
          <IconX size={14} />
        </ActionIcon>
      </Group>
    </Group>
  );
}

/**
 * Type-to-filter picker over registered options.
 *
 * `Autocomplete` rather than `MultiSelect` because the picked values are not
 * plain strings at every call site — a bound MCP server carries header
 * overrides and a tool selection, a subagent carries its type — and rendering
 * those as `MultiSelect` pills would drop everything but the name.
 */
function OptionPicker<T extends PickerOption>({
  options,
  placeholder,
  onPick,
}: {
  options: T[];
  placeholder?: string;
  onPick: (option: T) => void;
}) {
  const [draft, setDraft] = useState("");

  return (
    <Autocomplete
      mt={6}
      value={draft}
      onChange={setDraft}
      placeholder={placeholder}
      data={options.map((option) => option.value)}
      filter={({ options: items, search }) => {
        const query = search.trim().toLowerCase();
        if (!query) {
          return items;
        }
        return items.filter((item) => {
          const value = "value" in item ? item.value : "";
          const option = options.find((candidate) => candidate.value === value);
          return (
            value.toLowerCase().includes(query) ||
            (option?.description ?? "").toLowerCase().includes(query)
          );
        });
      }}
      renderOption={({ option }) => {
        const meta = options.find((candidate) => candidate.value === option.value);
        return (
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <Text fz="sm" style={{ flexShrink: 0 }}>
              {option.value}
            </Text>
            {meta?.badge && (
              <Badge size="xs" color={meta.badgeColor}>
                {meta.badge}
              </Badge>
            )}
            {meta?.description && (
              <Text fz="xs" c="dimmed" truncate>
                {meta.description}
              </Text>
            )}
          </Group>
        );
      }}
      onOptionSubmit={(value) => {
        const option = options.find((candidate) => candidate.value === value);
        if (option) {
          onPick(option);
        }
        setDraft("");
      }}
      comboboxProps={{ withinPortal: false }}
    />
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
  const available = options.filter((option) => !values.includes(option.value));

  return (
    <Field label={label}>
      <Group gap={6}>
        {values.map((value) => (
          <Badge
            key={value}
            variant="light"
            color="gray"
            rightSection={
              <ActionIcon
                size={14}
                variant="transparent"
                color="gray"
                onClick={() => onChange(values.filter((v) => v !== value))}
                aria-label={`Remove ${value}`}
              >
                <IconX size={12} />
              </ActionIcon>
            }
          >
            {value}
          </Badge>
        ))}
      </Group>
      <OptionPicker
        options={available}
        placeholder={placeholder}
        onPick={(option) => {
          if (!values.includes(option.value)) {
            onChange([...values, option.value]);
          }
        }}
      />
    </Field>
  );
}

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
      <Text fz="sm" c="dimmed">
        {error}
        {" — a run would offer none of this server’s tools until it answers."}
      </Text>
    );
  }
  if (!tools) {
    return (
      <Text fz="sm" c="dimmed">
        Loading tools…
      </Text>
    );
  }
  if (tools.length === 0) {
    return (
      <Text fz="sm" c="dimmed">
        This server exposes no tools.
      </Text>
    );
  }

  const chosen = selected ?? [];
  // A stored name the server no longer exposes stays listed so it can be cleared.
  const missing = chosen.filter((name) => !tools.some((tool) => tool.name === name));
  return (
    <Stack gap={4}>
      <Text fz="sm" c="dimmed">
        {chosen.length === 0
          ? "Every tool is offered. Select some to narrow what the model sees."
          : `${chosen.length} of ${tools.length} tools offered.`}
      </Text>
      {[...tools, ...missing.map((name) => ({ name, description: "no longer exposed" }))].map(
        (tool) => (
          <Checkbox
            key={tool.name}
            checked={chosen.includes(tool.name)}
            onChange={(event) =>
              onChange(
                event.currentTarget.checked
                  ? [...chosen, tool.name]
                  : chosen.filter((name) => name !== tool.name),
              )
            }
            label={
              <Text fz="sm" component="span">
                <Text component="span" ff="monospace" fz="sm">
                  {tool.name}
                </Text>
                {tool.description && (
                  <Text component="span" c="dimmed" fz="sm" ml={4}>
                    {tool.description}
                  </Text>
                )}
              </Text>
            }
          />
        ),
      )}
    </Stack>
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
    <Stack
      gap="xs"
      px="xs"
      py="xs"
      style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
    >
      {inheritedNames.length > 0 && (
        <Stack gap={4}>
          <Text fz="xs" c="dimmed">
            Inherited from the registry entry — select one to override it here.
          </Text>
          {inheritedNames.map((name) => {
            const taken = overridden.has(name.toLowerCase());
            return (
              <UnstyledButton
                key={name}
                disabled={taken}
                onClick={() => onChange([...rows, { key: name, value: "", remove: false }])}
                px={4}
                py={2}
                style={{
                  borderRadius: "var(--mantine-radius-sm)",
                  cursor: taken ? "default" : "pointer",
                  opacity: taken ? 0.4 : 1,
                }}
              >
                <Group gap="xs" wrap="nowrap">
                  <Text fz="xs" ff="monospace" c="dimmed">
                    {name}
                  </Text>
                  <Text fz="xs" ff="monospace" c="dimmed" truncate>
                    {inherited[name]}
                  </Text>
                  {taken && (
                    <Text fz="xs" c="dimmed" ml="auto" style={{ flexShrink: 0 }}>
                      overridden
                    </Text>
                  )}
                </Group>
              </UnstyledButton>
            );
          })}
        </Stack>
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
    </Stack>
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
  save,
}: {
  projectName: string;
  values: McpBinding[];
  onChange: (values: McpBinding[]) => void;
  options: PickerOption[];
  /** The page's version save, for the settings dialog's footer. */
  save: VersionSave;
}) {
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

  const available = options.filter((option) => !values.some((v) => v.name === option.value));

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
        // Rebuild from the binding, not from its name: writing `{ name, headers }`
        // dropped whatever else it carried, so editing a header silently reset
        // the tool selection sitting in the same dialog.
        const { headers: _previous, ...rest } = binding;
        const headers = rowsToOverrides(rows);
        return headers ? { ...rest, headers } : rest;
      }),
    );
  }

  return (
    <Field label="MCP servers">
      <Stack gap={6}>
        {values.map((binding) => {
          const count = Object.keys(binding.headers ?? {}).length;
          return (
            <PickedChip
              key={binding.name}
              label={binding.name}
              suffix={
                <Text component="span" c="dimmed" fz="xs">
                  {count > 0 && ` (${count} header override${count === 1 ? "" : "s"})`}
                  {` (${binding.tools?.length ? `${binding.tools.length} tools` : "all tools"})`}
                </Text>
              }
              action={
                <Anchor
                  component="button"
                  type="button"
                  fz="xs"
                  c="dimmed"
                  onClick={() => setSettingsFor(binding.name)}
                >
                  Settings
                </Anchor>
              }
              onRemove={() => remove(binding.name)}
            />
          );
        })}
        {settingsFor && (
          <McpBindingSettings
            projectName={projectName}
            serverName={settingsFor}
            onClose={() => setSettingsFor(null)}
            save={save}
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
      </Stack>
      <OptionPicker
        options={available}
        placeholder="Search registered MCP servers"
        onPick={(option) => {
          if (!values.some((v) => v.name === option.value)) {
            onChange([...values, { name: option.value }]);
          }
        }}
      />
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
  const available = options.filter((option) => !values.some((v) => v.name === option.value));

  return (
    <Field label="Subagents">
      <Stack gap={6}>
        {values.map((ref) => (
          <PickedChip
            key={ref.name}
            label={ref.name}
            suffix={
              <Text component="span" c="dimmed" fz="xs">
                {` (${ref.type})`}
              </Text>
            }
            onRemove={() => onChange(values.filter((v) => v.name !== ref.name))}
          />
        ))}
      </Stack>
      <OptionPicker
        options={available}
        placeholder="Search projects and external agents"
        onPick={(option) => {
          if (!values.some((v) => v.name === option.value)) {
            onChange([...values, { name: option.value, type: option.type }]);
          }
        }}
      />
    </Field>
  );
}
