import { Text } from "@mantine/core";

/**
 * The label on a card that holds a chart or a table.
 *
 * One shape, because there were two: the overview wrote a bold title with a
 * dimmed line under it ("Daily cost" / "Stacked by model"), while the agent
 * usage and profile pages wrote a small uppercase letter-spaced label. The
 * same chart therefore introduced itself two different ways depending on which
 * page you reached it from. The bold form wins because it has somewhere to put
 * the second line, and that line is worth having — what a stacked chart is
 * stacked *by* is not otherwise visible.
 */
export function CardHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <Text fw={600}>{title}</Text>
      {subtitle && (
        <Text fz="xs" c="dimmed">
          {subtitle}
        </Text>
      )}
    </div>
  );
}
