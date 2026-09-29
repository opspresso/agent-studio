"use client";

import { Alert, Badge, Button, Stack, Switch, Text } from "@mantine/core";
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
  onSelect,
  selected,
  runAsOwner,
  onRunAsOwnerChange,
  busy,
  children,
}: {
  title: string;
  view: { enabled: boolean; configured: boolean } | null;
  error: string | null;
  onRetry: () => void;
  onSelect?: () => void;
  selected?: boolean;
  runAsOwner?: boolean;
  onRunAsOwnerChange?: (value: boolean) => void;
  busy?: boolean;
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
  return <CollapsibleSection title={title} badge={badge} onSelect={onSelect} selected={selected}
    selectLabel={onSelect ? t("pint.historyView") : undefined}>
    {view ? <Stack gap="md">
      {onRunAsOwnerChange && <Switch label={t("trigger.runAsOwner")} description={t("integrations.runAsOwnerHint")}
        checked={runAsOwner ?? false} disabled={busy}
        onChange={event => onRunAsOwnerChange(event.currentTarget.checked)} />}
      {children}
    </Stack> : error ? <Alert color="red"><Stack gap="xs" align="flex-start">
      <Text size="sm">{error}</Text>
      <Button size="xs" variant="light" onClick={onRetry}>{t("error.retry")}</Button>
    </Stack></Alert> : <LoadingText />}
  </CollapsibleSection>;
}
