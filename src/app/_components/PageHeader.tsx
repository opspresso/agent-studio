import { Group, Text, ThemeIcon, Title } from "@mantine/core";
import type { TablerIcon } from "@tabler/icons-react";

export function PageHeader({
  title,
  description,
  Icon,
}: {
  title: string;
  description: string;
  Icon: TablerIcon;
}) {
  return (
    <Group gap="md" wrap="nowrap" align="flex-start">
      <ThemeIcon size={42} radius="lg" variant="light" color="brand" style={{ flexShrink: 0 }}>
        <Icon size={23} stroke={1.7} />
      </ThemeIcon>
      <div style={{ minWidth: 0 }}>
        <Title order={1} fz={{ base: 26, md: 30 }} lts="-0.025em">
          {title}
        </Title>
        <Text fz="sm" c="dimmed" mt={4} maw={720} style={{ wordBreak: "keep-all" }}>
          {description}
        </Text>
      </div>
    </Group>
  );
}
