"use client";

import { Checkbox, Divider, Select, SimpleGrid, Stack, Text } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { ModelSelect } from "@/app/_components/modelOptions";
import { CALL_PURPOSES, MODEL_TIERS, DEFAULT_CALL_ROUTING, CALL_ROUTING_LIMITS, type CallRoutingSettings, type ModelTier } from "@/domain/llm/callRouting";
import type { SelectableModel } from "../../lib/api";
import { NumberField } from "./inputs";

export function ModelRoutingEditor({ value, models, onChange }: {
  value?: CallRoutingSettings;
  models: SelectableModel[];
  onChange(value: CallRoutingSettings): void;
}) {
  const t = useT();
  const current = value ?? DEFAULT_CALL_ROUTING;
  const patch = (next: Partial<CallRoutingSettings>) => onChange({ ...current, ...next });
  function tierModel(tier: ModelTier, model: string | null) {
    const tiers = { ...current.tiers };
    if (model) tiers[tier] = model;
    else delete tiers[tier];
    const policies = { ...current.policies };
    for (const purpose of CALL_PURPOSES) if (!model && policies[purpose] === tier) delete policies[purpose];
    patch({ tiers, policies });
  }
  return <Stack gap="sm">
    <Divider label={t("routing.title")} labelPosition="left" />
    <Checkbox label={t("routing.enabled")} checked={current.enabled}
      description={t("routing.hint")} onChange={(event) => patch({ enabled: event.currentTarget.checked })} />
    {current.enabled && <>
      <Text size="xs" c="dimmed">{t("routing.privacy")}</Text>
      <Checkbox label={t("routing.localOnly")} checked={current.localOnly}
        onChange={(event) => patch({ localOnly: event.currentTarget.checked })} />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        {MODEL_TIERS.map((tier) => {
          const candidates = models.filter((model) => (!current.localOnly || model.providerKind === "selfhosted") &&
            (tier !== "vision" || model.capabilities.imageInput) && (tier !== "reasoning" || model.capabilities.reasoning));
          const id = current.tiers[tier];
          return <ModelSelect key={tier} label={t(`routing.tier.${tier}`)} models={candidates} value={id ?? null}
            onChange={(model) => tierModel(tier, model)} clearable searchable placeholder={t("routing.unassigned")}
            leading={id && !candidates.some((model) => model.id === id) ? [{ value: id, label: id }] : []} />;
        })}
      </SimpleGrid>
      <Text size="sm">{t("routing.policies")}</Text>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        {CALL_PURPOSES.map((purpose) => <Select key={purpose} label={t(`routing.purpose.${purpose}`)}
          value={current.policies[purpose] ?? null} clearable placeholder={t("routing.automatic")}
          data={MODEL_TIERS.filter((tier) => current.tiers[tier]).map((tier) => ({ value: tier, label: t(`routing.tier.${tier}`) }))}
          onChange={(tier) => {
            const policies = { ...current.policies };
            if (tier) policies[purpose] = tier as ModelTier;
            else delete policies[purpose];
            patch({ policies });
          }} />)}
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <NumberField label={t("routing.callBudget")} value={current.maxCallCostUsd} min={0.000001} max={CALL_ROUTING_LIMITS.maxBudgetUsd} step={0.01}
          onChange={(maxCallCostUsd) => patch({ maxCallCostUsd: maxCallCostUsd ?? DEFAULT_CALL_ROUTING.maxCallCostUsd })} />
        <NumberField label={t("routing.runBudget")} value={current.maxRunCostUsd} min={0.000001} max={CALL_ROUTING_LIMITS.maxBudgetUsd} step={0.1}
          onChange={(maxRunCostUsd) => patch({ maxRunCostUsd: maxRunCostUsd ?? DEFAULT_CALL_ROUTING.maxRunCostUsd })} />
        <NumberField label={t("routing.maxCalls")} value={current.maxCalls} min={1} max={CALL_ROUTING_LIMITS.maxCalls} step={1}
          onChange={(maxCalls) => patch({ maxCalls: maxCalls ?? DEFAULT_CALL_ROUTING.maxCalls })} />
        <NumberField label={t("routing.minOutputChars")} value={current.minOutputChars} min={1} max={CALL_ROUTING_LIMITS.maxMinOutputChars} step={1}
          onChange={(minOutputChars) => patch({ minOutputChars: minOutputChars ?? DEFAULT_CALL_ROUTING.minOutputChars })} />
      </SimpleGrid>
      <Text size="xs" c="dimmed">{t("routing.qualityHint")}</Text>
    </>}
  </Stack>;
}
