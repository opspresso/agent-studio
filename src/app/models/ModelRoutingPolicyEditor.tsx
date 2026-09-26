"use client";

import { Checkbox, NumberInput, Select, SimpleGrid, Stack, Text } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { ModelSelect } from "@/app/_components/modelOptions";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { CALL_PURPOSES, MODEL_TIERS, DEFAULT_CALL_ROUTING_POLICY, CALL_ROUTING_LIMITS, type CallRoutingPolicy, type ModelTier } from "@/domain/llm/callRouting";
import type { SelectableModel } from "@/app/api/models/route";

export function ModelRoutingPolicyEditor({ value, models, onChange }: {
  value: CallRoutingPolicy; models: SelectableModel[]; onChange(value: CallRoutingPolicy): void;
}) {
  const t = useT();
  const patch = (next: Partial<CallRoutingPolicy>) => onChange({ ...value, ...next });
  function tierModel(tier: ModelTier, model: string | null) {
    const tiers = { ...value.tiers };
    if (model) tiers[tier] = model;
    else delete tiers[tier];
    const policies = { ...value.policies };
    for (const purpose of CALL_PURPOSES) if (!model && policies[purpose] === tier) delete policies[purpose];
    patch({ tiers, policies });
  }
  return <Stack gap="sm">
    <Text size="sm" c="dimmed">{t("routing.globalHint")}</Text>
    <SimpleGrid cols={{ base: 1, sm: 2 }}>
      {MODEL_TIERS.map(tier => {
        const candidates = models.filter(model => (!value.localOnly || model.providerKind === "selfhosted") &&
          (tier !== "vision" || model.capabilities.imageInput) && (tier !== "reasoning" || model.capabilities.reasoning));
        const id = value.tiers[tier];
        return <ModelSelect key={tier} label={t(`routing.tier.${tier}`)} models={candidates} value={id ?? null}
          onChange={model => tierModel(tier, model)} clearable searchable placeholder={t("routing.unassigned")}
          leading={id && !candidates.some(model => model.id === id) ? [{ value: id, label: id }] : []} />;
      })}
    </SimpleGrid>
    <CollapsibleSection title={t("routing.advanced")}>
      <Stack gap="sm">
        <Text size="xs" c="dimmed">{t("routing.privacy")}</Text>
        <Checkbox label={t("routing.localOnly")} checked={value.localOnly}
          onChange={event => patch({ localOnly: event.currentTarget.checked })} />
        <Text size="sm">{t("routing.policies")}</Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          {CALL_PURPOSES.map(purpose => <Select key={purpose} label={t(`routing.purpose.${purpose}`)} value={value.policies[purpose] ?? null}
            clearable placeholder={t("routing.automatic")} data={MODEL_TIERS.filter(tier => value.tiers[tier]).map(tier => ({ value: tier, label: t(`routing.tier.${tier}`) }))}
            onChange={tier => {
              const policies = { ...value.policies };
              if (tier) policies[purpose] = tier as ModelTier;
              else delete policies[purpose];
              patch({ policies });
            }} />)}
        </SimpleGrid>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <NumberInput label={t("routing.callBudget")} value={value.maxCallCostUsd} min={0.000001} max={CALL_ROUTING_LIMITS.maxBudgetUsd} step={0.01}
            onChange={cost => patch({ maxCallCostUsd: typeof cost === "number" ? cost : DEFAULT_CALL_ROUTING_POLICY.maxCallCostUsd })} />
          <NumberInput label={t("routing.runBudget")} value={value.maxRunCostUsd} min={0.000001} max={CALL_ROUTING_LIMITS.maxBudgetUsd} step={0.1}
            onChange={cost => patch({ maxRunCostUsd: typeof cost === "number" ? cost : DEFAULT_CALL_ROUTING_POLICY.maxRunCostUsd })} />
          <NumberInput label={t("routing.maxCalls")} value={value.maxCalls} min={1} max={CALL_ROUTING_LIMITS.maxCalls} step={1} allowDecimal={false}
            onChange={count => patch({ maxCalls: typeof count === "number" ? count : DEFAULT_CALL_ROUTING_POLICY.maxCalls })} />
          <NumberInput label={t("routing.minOutputChars")} value={value.minOutputChars} min={1} max={CALL_ROUTING_LIMITS.maxMinOutputChars} step={1} allowDecimal={false}
            onChange={count => patch({ minOutputChars: typeof count === "number" ? count : DEFAULT_CALL_ROUTING_POLICY.minOutputChars })} />
        </SimpleGrid>
        <Text size="xs" c="dimmed">{t("routing.qualityHint")}</Text>
      </Stack>
    </CollapsibleSection>
  </Stack>;
}
