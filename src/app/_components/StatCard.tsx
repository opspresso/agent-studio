import { Card, Group, Text, ThemeIcon } from "@mantine/core";
import type { TablerIcon } from "@tabler/icons-react";
import classes from "./StatCard.module.css";

/**
 * One headline number with its label and a line of context.
 *
 * Callers format the value for its unit and locale; this component owns the
 * shared visual hierarchy.
 */
export function StatCard({
  label,
  value,
  detail,
  Icon,
}: {
  label: string;
  value: string;
  detail: string;
  Icon: TablerIcon;
}) {
  return (
    <Card className={classes.statCard}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div style={{ minWidth: 0 }}>
          <Text fz={10} fw={600} tt="uppercase" c="dimmed" lts="0.1em">
            {label}
          </Text>
          <Text fz={30} fw={650} mt={6} lts="-0.035em">
            {value}
          </Text>
          <Text fz="xs" c="dimmed" mt={2}>
            {detail}
          </Text>
        </div>
        <ThemeIcon variant="light" color="brand" size={38} radius="lg">
          <Icon size={19} stroke={1.7} />
        </ThemeIcon>
      </Group>
    </Card>
  );
}
