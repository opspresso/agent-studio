"use client";

import { SegmentedControl } from "@mantine/core";
import type { GroupBy } from "@/app/_lib/usage";
import type { MessageKey } from "@/app/_i18n/messages/en";
import { useT } from "@/app/_i18n/provider";

/**
 * What each axis is called, in one place.
 *
 * Three components read it — this control, the breakdown table's column
 * header, and the "Grouped by …" / "Stacked by …" captions — and an axis that
 * reads as `model` in the control and `모델` in the caption above it is the
 * same drift the control itself exists to prevent.
 */
export const GROUP_BY_LABEL: Record<GroupBy, MessageKey> = {
  agent: "usage.groupBy.agent",
  model: "usage.groupBy.model",
  provider: "usage.groupBy.provider",
  department: "usage.groupBy.department",
};

/**
 * Which axis a cost chart and its breakdown are grouped by.
 *
 * The options are the caller's because the three surfaces can answer
 * different questions from the same rows: the overview knows every agent
 * and their departments, a member's own rows know their agents but no
 * department map, and one agent's rows have nothing left to say about
 * agents at all. What must not differ is the control itself — the reader
 * learns it once.
 */
export function GroupByControl({
  value,
  onChange,
  options,
}: {
  value: GroupBy;
  onChange: (value: GroupBy) => void;
  options: readonly GroupBy[];
}) {
  const t = useT();
  return (
    <SegmentedControl
      size="xs"
      value={value}
      onChange={(next) => onChange(next as GroupBy)}
      data={options.map((option) => ({ value: option, label: t(GROUP_BY_LABEL[option]) }))}
    />
  );
}
