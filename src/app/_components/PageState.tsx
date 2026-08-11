import { Card, Text } from "@mantine/core";

/**
 * The two states a page-level list shows before it has rows. Like
 * `CardGrid`, these exist so the states read the same on every page — the
 * copies had already drifted between two font sizes and two shapes.
 */

/** The dimmed one-liner shown while a page's data loads. */
export function LoadingText() {
  return (
    <Text fz="sm" c="dimmed">
      Loading…
    </Text>
  );
}

/** A bordered card standing in for a list with nothing to show. */
export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <Text fz="sm" c="dimmed">
        {children}
      </Text>
    </Card>
  );
}
