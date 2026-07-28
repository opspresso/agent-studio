"use client";

import { Button, Group, TextInput } from "@mantine/core";
import { DATE_PRESETS, presetRange, type DateRange } from "@/app/_lib/dateRange";

/**
 * Shared From/To date range picker with quick-select preset buttons. Used by the
 * cost dashboard, project usage, and project traces so date search looks and
 * behaves the same everywhere.
 *
 * Native date inputs on purpose: the range is two plain ISO dates the API takes
 * verbatim, and a calendar popover would add a package for no behaviour the
 * three call sites use.
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
    <Group gap="xs" align="flex-end">
      <TextInput
        type="date"
        label="From"
        size="xs"
        value={value.from}
        max={value.to}
        onChange={(event) => onChange({ ...value, from: event.currentTarget.value })}
      />
      <TextInput
        type="date"
        label="To"
        size="xs"
        value={value.to}
        min={value.from}
        onChange={(event) => onChange({ ...value, to: event.currentTarget.value })}
      />
      {presets.length > 0 && (
        <Button.Group>
          {presets.map((days) => (
            <Button
              key={days}
              variant="default"
              size="compact-xs"
              onClick={() => onChange(presetRange(days))}
            >
              {days}d
            </Button>
          ))}
        </Button.Group>
      )}
    </Group>
  );
}
