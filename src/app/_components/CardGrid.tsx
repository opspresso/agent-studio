/**
 * The registry list shape: loading, then empty, then a grid of cards.
 *
 * Four pages — agents, tools, skills, projects — spelled this out identically,
 * down to the breakpoints. The card surface itself is now Mantine's `Card`
 * (see the `Card` defaults in `src/app/theme.ts`); what stays here is the
 * three states and the grid, because those are what has to read the same across
 * pages for the section to look like one thing.
 */

import { Group, Loader, SimpleGrid, Text } from "@mantine/core";

/** The grid alone, for a section that has already decided it has something to show. */
export function CardList({ children }: { children: React.ReactNode }) {
  return (
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
      {children}
    </SimpleGrid>
  );
}

export function CardGrid({
  loading,
  empty,
  emptyText,
  children,
}: {
  loading: boolean;
  empty: boolean;
  emptyText: string;
  children: React.ReactNode;
}) {
  if (loading) {
    return (
      <Group gap="xs">
        <Loader size="xs" />
        <Text size="sm" c="dimmed">
          Loading…
        </Text>
      </Group>
    );
  }
  if (empty) {
    return (
      <Text size="sm" c="dimmed">
        {emptyText}
      </Text>
    );
  }
  return <CardList>{children}</CardList>;
}
