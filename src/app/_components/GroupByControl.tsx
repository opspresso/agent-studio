import { SegmentedControl } from "@mantine/core";
import type { GroupBy } from "@/app/_lib/usage";

/**
 * Which axis a cost chart and its breakdown are grouped by.
 *
 * The options are the caller's because the three surfaces can answer
 * different questions from the same rows: the overview knows every project
 * and their departments, a member's own rows know their projects but no
 * department map, and one project's rows have nothing left to say about
 * projects at all. What must not differ is the control itself — the reader
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
  return (
    <SegmentedControl
      size="xs"
      value={value}
      onChange={(next) => onChange(next as GroupBy)}
      data={options.map((option) => ({ value: option, label: option }))}
    />
  );
}
