import { Text } from "@mantine/core";

/**
 * Shared chart and table heading. A bold title names the content; the optional
 * subtitle explains its grouping or scope.
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
