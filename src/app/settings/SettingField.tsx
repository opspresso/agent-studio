"use client";

import { Badge, Group, Select, Text, TextInput } from "@mantine/core";
import { monoInput } from "@/app/_components/monoInput";

/**
 * One setting, with the badge saying where its value came from.
 *
 * Shared by the deployment's settings and a workspace's, which report *different
 * source vocabularies* — `override | env | default | unset` against
 * `workspace | inherited` — so the badge arrives resolved rather than being
 * decided here. What is shared is the part that would otherwise be copied: the
 * monospace label, and the text-box-or-select branch.
 */
export interface SettingFieldProps {
  label: string;
  badge: { text: string; color: string };
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Renders a Select instead of a text box, for a setting with a closed set of values. */
  options?: readonly string[];
}

export function SettingField({
  label,
  badge,
  value,
  onChange,
  placeholder,
  options,
}: SettingFieldProps) {
  const labelNode = (
    <Group component="span" gap="xs">
      <Text component="span" ff="monospace" fz="sm" fw={500}>
        {label}
      </Text>
      <Badge color={badge.color}>{badge.text}</Badge>
    </Group>
  );

  if (options) {
    return (
      <Select
        label={labelNode}
        value={value || null}
        // Clearing is how a field falls back to the layer below, so `null` has
        // to reach the patch as the empty string every other field clears with.
        onChange={(next) => onChange(next ?? "")}
        data={[...options]}
        placeholder="inherit"
        clearable
        w={220}
        styles={monoInput}
      />
    );
  }

  return (
    <TextInput
      label={labelNode}
      value={value}
      onChange={(event) => {
        // Read now, not inside a state updater: React nulls a synthetic event's
        // `currentTarget` once the handler returns, and an updater runs on the
        // next render.
        onChange(event.currentTarget.value);
      }}
      placeholder={placeholder}
      styles={monoInput}
    />
  );
}
