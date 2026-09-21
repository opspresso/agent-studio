import { Group, Text, Title } from "@mantine/core";

/** Section titles and their actions use the same hierarchy on every console page. */
export function SectionHeading({ title, description, children }: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return <Group justify="space-between" align="flex-start" gap="md" wrap="wrap">
    <div style={{ minWidth: 0, flex: "1 1 240px" }}>
      <Title order={2} fz="h4" style={{ overflowWrap: "anywhere" }}>{title}</Title>
      {description && <Text c="dimmed" size="sm" mt={4} maw={760}>{description}</Text>}
    </div>
    {children && <Group gap="xs" wrap="wrap">{children}</Group>}
  </Group>;
}
