"use client";

import { Alert, Badge, Button, Stack, Text } from "@mantine/core";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { LoadingText } from "@/app/_components/PageState";
import { stateColor } from "@/app/_components/badgeColors";
import { useT } from "@/app/_i18n/provider";

/** A bot keeps its named section visible while its settings load or fail. */
export function BotIntegrationSection({
  title,
  view,
  error,
  onRetry,
  children,
}: {
  title: string;
  view: { enabled: boolean; configured: boolean } | null;
  error: string | null;
  onRetry: () => void;
  children?: React.ReactNode;
}) {
  const t = useT();
  const badge = error && !view
    ? <Badge color="red" radius="xl">{t("integrations.unavailable")}</Badge>
    : view
      ? <Badge color={stateColor(view.enabled)} radius="xl">
          {t(view.enabled ? "integrations.enabled" : view.configured ? "integrations.configuredOff" : "integrations.notConnected")}
        </Badge>
      : undefined;
  return <CollapsibleSection title={title} badge={badge}>
    {view ? children : error ? <Alert color="red"><Stack gap="xs" align="flex-start">
      <Text size="sm">{error}</Text>
      <Button size="xs" variant="light" onClick={onRetry}>{t("error.retry")}</Button>
    </Stack></Alert> : <LoadingText />}
  </CollapsibleSection>;
}
