"use client";

import { Alert, Card, Group, Loader, Stack, Text } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import type { TablerIcon } from "@tabler/icons-react";
import { BackLink } from "./BackLink";
import { PageHeader } from "./PageHeader";

/** Keep a registry item's identity and way back visible before its details are available. */
export function DetailPageState({ name, backHref, backLabel, Icon, loading, error }: {
  name: string; backHref: string; backLabel: string; Icon: TablerIcon; loading: boolean; error: string | null;
}) {
  const t = useT();
  return <Stack gap="lg">
    <BackLink href={backHref} label={backLabel} />
    <PageHeader title={name} Icon={Icon} />
    {loading ? <LoadingText /> : <Alert color="red">{error ?? t("registry.itemUnavailable")}</Alert>}
  </Stack>;
}

/** Shared loading and empty states for client list pages. */

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
