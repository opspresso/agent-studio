import { Group, Text, Title } from "@mantine/core";
import type { TablerIcon } from "@tabler/icons-react";

/**
 * The light page header — icon beside title and description — shared by the
 * admin pages (Settings, Members, Audit trail) and the profile page. Catalog
 * pages use the heavier `CatalogHeader`. `wrap="nowrap"` is load-bearing: a Group wraps before it
 * shrinks, so a long description would otherwise push the whole text block
 * onto the next line, leaving the icon alone on top.
 */
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
      <Icon size={30} style={{ flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <Title order={1} fz="h2">
          {title}
        </Title>
        {/*
          The only prose on these pages, and the only part with a reading
          width: Members and the audit trail put tables under it that use the
          whole shell, and a sentence stretched to match them is unreadable.
        */}
        <Text fz="sm" c="dimmed" mt={4} maw={720}>
          {description}
        </Text>
      </div>
    </Group>
  );
}
