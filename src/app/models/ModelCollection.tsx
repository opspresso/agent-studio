"use client";

import { useMemo, useState } from "react";
import { Badge, Button, Card, Checkbox, Group, Pagination, Select, Stack, Text } from "@mantine/core";
import { CardList } from "@/app/_components/CardGrid";
import { CatalogSearch, matchesFilter } from "@/app/_components/CatalogSearch";
import { EmptyState } from "@/app/_components/PageState";
import { formatModelPrice, modelPriceLabel } from "@/app/_components/modelOptions";
import { useT } from "@/app/_i18n/provider";
import { contextWindowLabel } from "@/domain/llm/models";
import { REGISTRY_MODEL_TYPES, type DiscoveredModel } from "@/domain/llm/providerModels";
import { modelOutputTypes, nextSort, sortModelRows, type FilterCapability, type ModelSortKey, type SortDirection } from "./modelTable";

const capabilities = ["tools", "imageInput", "reasoning", "structuredOutput"] as const;
type ModelRow = DiscoveredModel & { id?: string; provider?: string };

/** Discovery, selected models and administration share the same facts, filters and ordering. */
export function ModelCollection<T extends ModelRow>({ models, provider, emptyText, renderActions, isSelected }: {
  models: T[];
  provider?: string;
  emptyText: string;
  renderActions?: (model: T) => React.ReactNode;
  isSelected?: (model: T) => boolean;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [flags, setFlags] = useState<FilterCapability[]>([]);
  const [sort, setSort] = useState<{ sortKey: ModelSortKey; direction: SortDirection }>({ sortKey: "name", direction: "asc" });
  const [page, setPage] = useState(1);
  const [selectedOnly, setSelectedOnly] = useState(false);
  const providers = [...new Set(models.flatMap(model => model.provider ? [model.provider] : []))].sort();
  const filtered = useMemo(() => sortModelRows(models.filter(model =>
    (!type || modelOutputTypes(model).includes(type)) && (!selectedProvider || model.provider === selectedProvider) &&
    (!selectedOnly || isSelected?.(model)) &&
    flags.every(flag => model.capabilities?.[flag] === true) && matchesFilter(query, model.displayName, model.wireId, model.provider, model.maker),
  ), sort.sortKey, sort.direction), [models, type, selectedProvider, flags, query, sort, selectedOnly, isSelected]);
  const pages = Math.max(1, Math.ceil(filtered.length / 24));
  const currentPage = Math.min(page, pages);
  return <Stack gap="md">
    <Group align="flex-start">
      <CatalogSearch value={query} onChange={value => { setQuery(value); setPage(1); }} placeholder={t("modelAdmin.search")}
        resultCount={filtered.length} totalCount={models.length}
        onReset={query || type || selectedProvider || flags.length || selectedOnly ? () => { setQuery(""); setType(null); setSelectedProvider(null); setFlags([]); setSelectedOnly(false); setPage(1); } : undefined} />
      <Select aria-label={t("models.type")} placeholder={t("models.type")} value={type} clearable
        data={REGISTRY_MODEL_TYPES.map(value => ({ value, label: t(`models.type.${value}`) }))} onChange={value => { setType(value); setPage(1); }} />
      {providers.length > 1 && <Select aria-label={t("modelAdmin.providers")} placeholder={t("modelAdmin.providers")} value={selectedProvider} data={providers} clearable
        onChange={value => { setSelectedProvider(value); setPage(1); }} />}
    </Group>
    <Group justify="space-between" gap="md">
      <Group gap="md">{isSelected && <Checkbox label={t("models.selectedOnly")} checked={selectedOnly} onChange={event => { setSelectedOnly(event.currentTarget.checked); setPage(1); }} />}
        {capabilities.map(flag => <Checkbox key={flag} label={t(`models.capability.${flag}`)} checked={flags.includes(flag)} onChange={event => {
        setFlags(event.currentTarget.checked ? [...flags, flag] : flags.filter(value => value !== flag)); setPage(1);
      }} />)}</Group>
      <Group gap="xs" role="group" aria-label={t("models.sort")}>
        {(["name", "price"] as const).map(key => <Button key={key} variant={sort.sortKey === key ? "light" : "default"} size="compact-sm"
          aria-pressed={sort.sortKey === key} title={key === "price" ? t("models.sortPriceHint") : undefined}
          onClick={() => { setSort(nextSort(sort.sortKey, sort.direction, key)); setPage(1); }}>
          {t(`models.sort.${key}`)}{sort.sortKey === key ? sort.direction === "asc" ? " ↑" : " ↓" : ""}
        </Button>)}
      </Group>
    </Group>
    {!filtered.length ? <EmptyState>{models.length ? t("settings.noResults") : emptyText}</EmptyState> : <CardList>
      {filtered.slice((currentPage - 1) * 24, currentPage * 24).map(model => <Card key={model.id ?? `${provider}/${model.wireId}`} component="article">
        <Stack gap="sm" h="100%">
          <div><Text fw={600} style={{ overflowWrap: "anywhere" }}>{model.displayName}</Text>
            <Text size="xs" ff="monospace" c="dimmed" style={{ overflowWrap: "anywhere" }}>{model.wireId}</Text></div>
          <Group gap={5}>
            {(model.provider || provider) && <Badge color="brand">{model.provider || provider}</Badge>}
            {modelOutputTypes(model).length ? modelOutputTypes(model).map(type => <Badge key={type}>
              {REGISTRY_MODEL_TYPES.includes(type as typeof REGISTRY_MODEL_TYPES[number]) ? t(`models.type.${type as typeof REGISTRY_MODEL_TYPES[number]}`) : type}
            </Badge>) : <Badge>{t("modelAdmin.unknownType")}</Badge>}
            {capabilities.filter(flag => model.capabilities?.[flag] === true).map(flag => <Badge key={flag} variant="outline" color="gray">{t(`models.capability.${flag}`)}</Badge>)}
          </Group>
          <div>
            <Text size="sm" fw={500}>{modelPriceLabel(model.pricing, model.type)}</Text>
            <Text size="xs" c="dimmed" mt={4}>{contextWindowLabel({ contextWindow: model.contextWindow ?? 0, maxTokens: model.maxTokens ?? 0,
              capabilities: { tools: false, structuredOutput: false, imageInput: false, reasoning: false, embedding: model.type === "embedding", rerank: model.type === "rerank" } })}</Text>
            {model.pricing?.cachedInputPer1M !== undefined && <Text size="xs" c="dimmed">{t("models.cached")} {formatModelPrice(model.pricing.cachedInputPer1M)} / 1M</Text>}
            {model.capabilities?.reasoning && model.capabilities.reasoningWithTools === false && <Text size="xs" c="dimmed">{t("models.reasoningNoTools")}</Text>}
          </div>
          {renderActions && <Group gap="xs" mt="auto" pt="xs">{renderActions(model)}</Group>}
        </Stack>
      </Card>)}
    </CardList>}
    {pages > 1 && <Pagination total={pages} value={currentPage} onChange={setPage} />}
  </Stack>;
}
