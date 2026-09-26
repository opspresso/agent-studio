"use client";

import { useMemo } from "react";
import { useLocalStorage } from "@mantine/hooks";
import { Badge, Button, Checkbox, Group, Pagination, Select, Stack, Text } from "@mantine/core";
import { CatalogSearch } from "@/app/_components/CatalogSearch";
import { EmptyState } from "@/app/_components/PageState";
import { CatalogViewToggle, useCatalogView } from "@/app/_components/CatalogView";
import { formatModelPrice, modelPriceLabel } from "@/app/_components/modelOptions";
import { useT } from "@/app/_i18n/provider";
import { contextWindowLabel } from "@/domain/llm/models";
import { REGISTRY_MODEL_TYPES } from "@/domain/llm/providerModels";
import { activeModelProvider, DEFAULT_MODEL_BROWSER_STATE, MODEL_BROWSER_KEYS, MODEL_FILTER_CAPABILITIES, deserializeModelBrowserState, filterModelRows, modelOutputTypes, nextSort, type ModelBrowserState, type ModelRow } from "./modelTable";
import classes from "./ModelCollection.module.css";


/** Discovery, selected models and administration share the same facts, filters and ordering. */
export function ModelCollection<T extends ModelRow>({ models, provider, emptyText, renderActions, isSelected, scope }: {
  models: T[];
  provider?: string;
  emptyText: string;
  renderActions?: (model: T) => React.ReactNode;
  isSelected?: (model: T) => boolean;
  scope: "browse" | "discovery" | "registered";
}) {
  const t = useT();
  const [view, setView] = useCatalogView();
  const [preferences, setPreferences] = useLocalStorage<ModelBrowserState>({
    key: MODEL_BROWSER_KEYS[scope], defaultValue: DEFAULT_MODEL_BROWSER_STATE, deserialize: deserializeModelBrowserState, sync: false,
  });
  const { query, type, capabilities: flags, sortKey, direction, page, selectedOnly } = preferences;
  const selectedProvider = provider ? null : activeModelProvider(models, preferences.provider);
  const update = (patch: Partial<ModelBrowserState>) => setPreferences(current => ({ ...current, page: 1, ...patch }));
  const providers = [...new Set(models.flatMap(model => model.provider ? [model.provider] : []))].sort();
  const filtered = useMemo(() => filterModelRows(models, { ...preferences, provider: selectedProvider }, isSelected, provider),
    [models, preferences, selectedProvider, isSelected, provider]);
  const pages = Math.max(1, Math.ceil(filtered.length / 24));
  const currentPage = Math.min(page, pages);
  return <Stack gap="md">
    <Group align="flex-start">
      <CatalogSearch value={query} onChange={query => update({ query })} placeholder={t("modelAdmin.search")}
        resultCount={filtered.length} totalCount={models.length}
        onReset={query || type || selectedProvider || flags.length || selectedOnly ? () => update({ query: "", type: null, provider: null, capabilities: [], selectedOnly: false }) : undefined} />
      <Select aria-label={t("models.type")} placeholder={t("models.type")} value={type} clearable
        data={REGISTRY_MODEL_TYPES.map(value => ({ value, label: t(`models.type.${value}`) }))} onChange={value => update({ type: value as ModelBrowserState["type"] })} />
      {providers.length > 1 && <Select aria-label={t("modelAdmin.providers")} placeholder={t("modelAdmin.providers")} value={selectedProvider} data={providers} clearable
        onChange={provider => update({ provider })} />}
    </Group>
    <Group justify="space-between" gap="md">
      <Group gap="md">{isSelected && <Checkbox label={t("models.selectedOnly")} checked={selectedOnly} onChange={event => update({ selectedOnly: event.currentTarget.checked })} />}
        {MODEL_FILTER_CAPABILITIES.map(flag => <Checkbox key={flag} label={t(`models.capability.${flag}`)} checked={flags.includes(flag)} onChange={event => {
        update({ capabilities: event.currentTarget.checked ? [...flags, flag] : flags.filter(value => value !== flag) });
      }} />)}</Group>
      <Group gap="sm">
        <Group gap="xs" role="group" aria-label={t("models.sort")}>
          {(["name", "price"] as const).map(key => <Button key={key} variant={sortKey === key ? "light" : "default"} size="compact-sm"
            aria-pressed={sortKey === key} title={key === "price" ? t("models.sortPriceHint") : undefined}
            onClick={() => update(nextSort(sortKey, direction, key))}>
            {t(`models.sort.${key}`)}{sortKey === key ? direction === "asc" ? " ↑" : " ↓" : ""}
          </Button>)}
        </Group>
        <CatalogViewToggle value={view} onChange={setView} />
      </Group>
    </Group>
    {!filtered.length ? <EmptyState>{models.length ? t("settings.noResults") : emptyText}</EmptyState> : (
      <div className={classes.collection}><div className={view === "grid" ? classes.grid : classes.list}
        role="table" aria-label={t("nav.models")}>
        <div className={classes.header} role="row">
          <span role="columnheader">{t("models.column.model")}</span><span role="columnheader">{t("models.column.capabilities")}</span>
          <span role="columnheader">{t("models.column.pricing")}</span><span role="columnheader">{t("models.column.actions")}</span>
        </div>
        {filtered.slice((currentPage - 1) * 24, currentPage * 24).map(model => (
          <div className={classes.row} role="row" key={model.id ?? `${provider}/${model.wireId}`}>
            <div className={classes.identity} role="cell">
              <Text fw={650}>{model.displayName}</Text>
              <Text className={classes.modelId} ff="monospace">{model.id ?? model.wireId}</Text>
              <Group gap={5} mt={8}>
                {(model.provider || provider) && <Badge color="gray">{model.provider || provider}</Badge>}
                {modelOutputTypes(model).length ? modelOutputTypes(model).map(type => <Badge key={type} color="gray">
                  {REGISTRY_MODEL_TYPES.includes(type as typeof REGISTRY_MODEL_TYPES[number]) ? t(`models.type.${type as typeof REGISTRY_MODEL_TYPES[number]}`) : type}
                </Badge>) : <Badge color="gray">{t("modelAdmin.unknownType")}</Badge>}
              </Group>
            </div>
            <div className={classes.capabilities} role="cell">
              <Text className={classes.mobileLabel} aria-hidden="true">{t("models.column.capabilities")}</Text>
              <Group gap={5}>{MODEL_FILTER_CAPABILITIES.filter(flag => model.capabilities?.[flag] === true)
                .map(flag => <Badge key={flag} variant="outline" color="gray">{t(`models.capability.${flag}`)}</Badge>)}</Group>
            </div>
            <div className={classes.pricing} role="cell">
              <Text className={classes.mobileLabel} aria-hidden="true">{t("models.column.pricing")}</Text>
              <Text size="sm" fw={600}>{modelPriceLabel("pricingKnown" in model && model.pricingKnown === false ? undefined : model.pricing, model.type)}</Text>
              <Text size="xs" c="dimmed" mt={4}>{contextWindowLabel({ contextWindow: model.contextWindow ?? 0, maxTokens: model.maxTokens ?? 0,
                capabilities: { tools: false, structuredOutput: false, imageInput: false, reasoning: false, embedding: model.type === "embedding", rerank: model.type === "rerank" } })}</Text>
              {model.pricing?.cachedInputPer1M !== undefined && <Text size="xs" c="dimmed">{t("models.cached")} {formatModelPrice(model.pricing.cachedInputPer1M)} / 1M</Text>}
              {model.capabilities?.reasoning && model.capabilities.reasoningWithTools === false && <Text size="xs" c="orange">{t("models.reasoningNoTools")}</Text>}
            </div>
            <div className={classes.actions} role="cell">
              {renderActions && <Group gap="xs">{renderActions(model)}</Group>}
            </div>
          </div>
        ))}
      </div></div>
    )}
    {pages > 1 && <Pagination total={pages} value={currentPage} onChange={page => update({ page })} />}
  </Stack>;
}
