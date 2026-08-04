/**
 * The registry list shape: loading, then empty, then a grid of cards.
 *
 * Four pages — agents, tools, skills, projects — spelled this out identically,
 * down to the breakpoints. The card surface itself is now Mantine's `Card`
 * (see the `Card` defaults in `src/app/theme.ts`); what stays here is the
 * three states and the grid, because those are what has to read the same across
 * pages for the section to look like one thing.
 */

import { Center, Paper, SimpleGrid, Skeleton, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconSparkles } from "@tabler/icons-react";

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
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md" aria-label="Loading">
        {Array.from({ length: 3 }, (_, index) => (
          <Paper key={index} withBorder p="md">
            <Skeleton height={16} width="48%" />
            <Skeleton height={10} mt="md" />
            <Skeleton height={10} mt="xs" width="72%" />
          </Paper>
        ))}
      </SimpleGrid>
    );
  }
  if (empty) {
    return (
      <Paper withBorder py={48} px="lg">
        <Center>
          <Stack gap="xs" align="center">
            <ThemeIcon variant="light" size={40} radius="xl">
              <IconSparkles size={20} stroke={1.7} />
            </ThemeIcon>
            <Text size="sm" c="dimmed" ta="center">
              {emptyText}
            </Text>
          </Stack>
        </Center>
      </Paper>
    );
  }
  return <CardList>{children}</CardList>;
}
