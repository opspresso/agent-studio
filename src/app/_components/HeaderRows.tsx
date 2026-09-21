"use client";

import { ActionIcon, Anchor, Badge, Checkbox, Group, Stack, Text, TextInput } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";
import { SecretInput } from "./SecretInput";
import { BADGE } from "./badgeColors";

export interface HeaderRow {
  key: string;
  value: string;
  /** Saved, masked baseline; serializers deliberately omit this editor metadata. */
  storedValue?: string;
  /**
   * Only meaningful where the rows layer over defaults (see `allowRemove`):
   * drop the inherited header rather than replace it. Registry headers have
   * nothing to drop, so their rows leave it unset.
   */
  remove?: boolean;
}

export function recordToRows(record: Record<string, string>): HeaderRow[] {
  return Object.entries(record).map(([key, value]) => ({ key, value, storedValue: value }));
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
 * Editable secret key/value rows. Every value is stored encrypted at rest, so
 * each row uses SecretInput. A saved baseline keeps the stored credential until
 * a replacement is entered. `allowRemove` drops an inherited header explicitly.
 */
export function HeaderRowsEditor({
  rows,
  onChange,
  emptyHint,
  caption,
  addLabel,
  keyPlaceholder,
  valuePlaceholder,
  allowRemove = false,
}: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
  emptyHint?: string;
  /**
   * `null` where the surrounding section already names these rows; omitted for
   * the translated default. The two are distinct, which is why the default is
   * resolved in the body rather than in the signature — `caption = t(…)` would
   * have made "no caption" unsayable.
   */
  caption?: string | null;
  addLabel?: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** Offer "remove", for rows that layer over a set of inherited headers. */
  allowRemove?: boolean;
}) {
  const t = useT();
  const captionText = caption === undefined ? t("headers.caption") : caption;

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
    <Stack gap="xs">
      {captionText !== null && (
        <Text fz="sm" fw={500}>
          {captionText}
        </Text>
      )}
      {rows.length === 0 && (
        <Text fz="xs" c="dimmed">
          {emptyHint ?? t("headers.empty")}
        </Text>
      )}
      {rows.map((row, index) => (
        <Group key={index} gap="xs" wrap="nowrap" align="center">
          <TextInput
            value={row.key}
            aria-label={keyPlaceholder ?? t("headers.keyPlaceholder")}
            onChange={(event) => update(index, {
              key: event.currentTarget.value,
              value: row.value === row.storedValue ? "" : row.value,
              storedValue: undefined,
            })}
            placeholder={keyPlaceholder ?? t("headers.keyPlaceholder")}
            w="40%"
          />
          <SecretInput
            aria-label={row.key || (valuePlaceholder ?? t("headers.valuePlaceholder"))}
            value={row.remove ? "" : row.value}
            storedValue={row.remove ? undefined : row.storedValue}
            onChange={(value) => update(index, { value })}
            disabled={row.remove === true}
            placeholder={
              row.remove ? t("headers.removed") : (valuePlaceholder ?? t("headers.valuePlaceholder"))
            }
            style={{ flex: 1 }}
          />
          {allowRemove ? (
            <Checkbox
              size="xs"
              label={t("headers.remove")}
              title={t("headers.removeHint")}
              checked={row.remove === true}
              onChange={(event) => update(index, { remove: event.currentTarget.checked })}
              styles={{ label: { fontSize: "var(--mantine-font-size-xs)" } }}
            />
          ) : (
            <Badge color={BADGE.attention} title={t("headers.secretHint")}>
              {t("headers.secret")}
            </Badge>
          )}
          <ActionIcon
            variant="default"
            onClick={() => remove(index)}
            aria-label={t("headers.deleteRow")}
          >
            <IconX size={16} />
          </ActionIcon>
        </Group>
      ))}
      <Anchor component="button" type="button" fz="sm" onClick={add} style={{ alignSelf: "start" }}>
        {addLabel ?? t("headers.add")}
      </Anchor>
    </Stack>
  );
}
