"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Anchor, Checkbox, Divider, Stack, Text } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { readJson } from "@/app/_lib/httpClient";
import { useViewer } from "@/app/_lib/useViewer";
import { MODEL_TIERS } from "@/domain/llm/callRouting";
import type { ModelRoutingResponse } from "@/app/api/models/routing/route";

export function ModelRoutingEditor({ value, onChange }: { value?: boolean; onChange(value: boolean): void }) {
  const t = useT();
  const viewer = useViewer();
  const [view, setView] = useState<ModelRoutingResponse>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!value) return;
    let current = true;
    void fetch("/api/models/routing").then(response => readJson<ModelRoutingResponse>(response))
      .then(next => { if (current) { setView(next); setError(undefined); } })
      .catch(error => { if (current) setError(error instanceof Error ? error.message : "Could not load routing policy"); });
    return () => { current = false; };
  }, [value]);
  const tiers = view ? MODEL_TIERS.filter(tier => view.policy.tiers[tier]) : [];
  return <Stack gap="xs">
    <Divider label={t("routing.title")} labelPosition="left" />
    <Checkbox label={t("routing.enabled")} checked={value === true} description={t("routing.hint")}
      onChange={event => onChange(event.currentTarget.checked)} />
    {value && <>
      <Text size="xs" c="dimmed">{t("routing.sharedHint")}</Text>
      {view && <Text size="xs" c={tiers.length ? "dimmed" : "orange"}>
        {tiers.length ? tiers.map(tier => `${t(`routing.tier.${tier}`)}: ${view.policy.tiers[tier]}`).join(" · ") : t("routing.noSharedModels")}
      </Text>}
      {error && <Text size="xs" c="red">{error}</Text>}
      {viewer?.isAdmin && <Anchor component={Link} href="/settings/model-usage" size="xs">{t("routing.manageShared")}</Anchor>}
    </>}
  </Stack>;
}
