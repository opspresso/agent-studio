"use client";

import { Card, Group, Loader, Text } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";

/**
 * The two states a page-level list shows before it has rows. Like
 * `CardGrid`, these exist so the states read the same on every page — the
 * copies had already drifted between two font sizes and two shapes.
 *
 * `"use client"` because the loading line is translated and every one of the
 * eighteen pages that renders these is a client component already.
 */

/** The dimmed one-liner shown while a page's data loads. */
export function LoadingText() {
  const t = useT();
  return (
    <Group gap="sm" role="status" py="md">
      <Loader size="xs" />
      <Text fz="sm" c="dimmed">{t("common.loading")}</Text>
    </Group>
  );
}

/** A bordered card standing in for a list with nothing to show. */
export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <Card py={40} px="lg" role="status">
      <Text fz="sm" c="dimmed" ta="center">
        {children}
      </Text>
    </Card>
  );
}
