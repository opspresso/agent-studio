/** Card grids remain for file galleries and Plugin detail collections. */

"use client";

import { Paper, SimpleGrid, Skeleton } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { EmptyState } from "./PageState";

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
  failed = false,
  empty,
  emptyText,
  children,
}: {
  loading: boolean;
  /** The caller renders its fetch error; do not also claim the catalog is empty. */
  failed?: boolean;
  empty: boolean;
  emptyText: string;
  children: React.ReactNode;
}) {
  const t = useT();
  if (loading) {
    return (
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md" aria-label={t("common.loading")}>
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
  if (failed) {
    return null;
  }
  if (empty) {
    return <EmptyState>{emptyText}</EmptyState>;
  }
  return <CardList>{children}</CardList>;
}
