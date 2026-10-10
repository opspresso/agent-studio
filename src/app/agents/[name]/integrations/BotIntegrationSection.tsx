"use client";

import { NavigationLink } from "@/app/_components/NavigationLink";

import { Alert, Badge, Button, Stack, Text } from "@mantine/core";
import { ConfigurationFields } from "@/app/_components/ConfigurationFields";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { LoadingText } from "@/app/_components/PageState";
import { BADGE, stateColor } from "@/app/_components/badgeColors";
import { useT } from "@/app/_i18n/provider";

/** A bot keeps its named section visible while its settings load or fail. */
export function BotIntegrationSection({
  title,
  view,
  error,
  onRetry,
  onSelect,
  selected,
  busy = false,
  children,
}: {
  title: string;
  view: { enabled: boolean; configured: boolean } | null;
  error: string | null;
  onRetry: () => void;
  onSelect?: () => void;
  selected?: boolean;
  busy?: boolean;
  children?: React.ReactNode;
}) {
  const t = useT();
  const badge = error && !view
    ? <Badge color={BADGE.broken}>{t("integrations.unavailable")}</Badge>
    : view
      ? <Badge color={stateColor(view.enabled)}>
          {t(view.enabled ? "integrations.enabled" : view.configured ? "integrations.configuredOff" : "integrations.notConnected")}
        </Badge>
      : undefined;
  return <CollapsibleSection title={title} badge={badge} onSelect={onSelect} selected={selected}
    selectLabel={onSelect ? t("pint.historyView") : undefined}>
    {view ? <Stack gap="md">
      <Text size="sm" c="dimmed">{t("integrations.callerAuthenticationHint")}</Text>
      <NavigationLink href="/profile/messaging">{t("messaging.identity.title")}</NavigationLink>
      <ConfigurationFields disabled={busy}>{children}</ConfigurationFields>
    </Stack> : error ? <Alert color="red"><Stack gap="xs" align="flex-start">
      <Text size="sm">{error}</Text>
      <Button size="xs" variant="light" onClick={onRetry}>{t("error.retry")}</Button>
    </Stack></Alert> : <LoadingText />}
  </CollapsibleSection>;
}
