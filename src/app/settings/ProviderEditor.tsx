"use client";

import { Badge, Button, Checkbox, Group, Select, Stack, Text, TextInput } from "@mantine/core";
import { monoInput } from "@/app/_components/monoInput";
import { SUPPORTED_PROVIDERS } from "@/domain/llm/models";

/**
 * The per-provider channel list, edited as rows.
 *
 * Shared by the deployment's settings and a workspace's. The two differ only in
 * what an empty list falls back to — the `LLM_PROVIDER_*` environment variables
 * for one, the deployment's whole list for the other — which is the caller's
 * `hint`, not a second copy of the editor.
 *
 * The provider names come from `SUPPORTED_PROVIDERS`, which is also what both
 * routes validate against: a select offering a name the server refuses is a
 * form that can only be submitted wrong.
 */
export interface ProviderRow {
  name: string;
  baseUrl: string;
  apiKey: string;
  keepModelPrefix: boolean;
}

export function ProviderEditor({
  rows,
  onChange,
  badge,
  hint,
}: {
  rows: ProviderRow[];
  onChange: (update: (prev: ProviderRow[]) => ProviderRow[]) => void;
  badge: { text: string; color: string };
  hint: string;
}) {
  const edit = (index: number, patch: Partial<ProviderRow>) =>
    onChange((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <Stack gap="sm">
      <Group gap="xs">
        <Text ff="monospace" fz="sm" fw={500}>
          LLM_PROVIDER_*
        </Text>
        <Badge color={badge.color}>{badge.text}</Badge>
      </Group>
      {rows.map((provider, index) => (
        <Group key={index} gap="xs" wrap="wrap" align="center">
          <Select
            value={provider.name}
            onChange={(value) => edit(index, { name: value ?? "" })}
            placeholder="provider…"
            allowDeselect={false}
            data={[...SUPPORTED_PROVIDERS]}
            w={144}
            styles={monoInput}
          />
          <TextInput
            value={provider.baseUrl}
            onChange={(event) => {
              const baseUrl = event.currentTarget.value;
              edit(index, { baseUrl });
            }}
            placeholder="base URL"
            miw={192}
            style={{ flex: 1 }}
            styles={monoInput}
          />
          <TextInput
            value={provider.apiKey}
            onChange={(event) => {
              const apiKey = event.currentTarget.value;
              edit(index, { apiKey });
            }}
            placeholder="API key"
            w={176}
            styles={monoInput}
          />
          <Checkbox
            size="xs"
            label="keep prefix"
            checked={provider.keepModelPrefix}
            onChange={(event) => {
              const keepModelPrefix = event.currentTarget.checked;
              edit(index, { keepModelPrefix });
            }}
          />
          <Button
            variant="default"
            size="compact-sm"
            onClick={() => onChange((prev) => prev.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </Group>
      ))}
      <Button
        variant="default"
        size="compact-sm"
        style={{ alignSelf: "flex-start" }}
        onClick={() =>
          onChange((prev) => [...prev, { name: "", baseUrl: "", apiKey: "", keepModelPrefix: false }])
        }
      >
        Add provider
      </Button>
      <Text fz="xs" c="dimmed">
        {hint}
      </Text>
    </Stack>
  );
}
