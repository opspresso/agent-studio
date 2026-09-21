"use client";

import { CatalogSearch, matchesFilter } from "@/app/_components/CatalogSearch";
import { DataTable } from "@/app/_components/DataTable";
import { LoadingText, EmptyState } from "@/app/_components/PageState";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Badge, Group, Pagination, Select, Stack, Table, Text } from "@mantine/core";
import { IconCpu } from "@tabler/icons-react";
import { PageHeader } from "@/app/_components/PageHeader";
import { useT } from "@/app/_i18n/provider";
import { readJson } from "@/app/_lib/httpClient";
import { REGISTRY_MODEL_TYPES, type RegisteredModel } from "@/domain/llm/providerModels";
import type { ModelRegistryResponse } from "@/app/api/models/registry/route";

export default function ModelsPage() {
  const t = useT();
  const [models, setModels] = useState<RegisteredModel[]>();
  const [query, setQuery] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => (await readJson<ModelRegistryResponse>(await fetch("/api/models/registry"))).models, []);
  useEffect(() => {
    let current = true;
    void load().then(value => { if (current) setModels(value); }).catch(error => { if (current) setError(error instanceof Error ? error.message : "Could not load models"); });
    return () => { current = false; };
  }, [load]);
  const filtered = useMemo(() => (models ?? []).filter(model => (!type || model.type === type) && (!provider || model.provider === provider) && matchesFilter(query, model.displayName, model.id)), [models, type, provider, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / 25));
  return <Stack gap="lg">
    <PageHeader title={t("nav.models")} description={t("modelAdmin.onlySelected")} Icon={IconCpu} />
    {error && <Alert color="red">{error}</Alert>}
    {!models && !error && <LoadingText />}
    {models && <>
      <Group align="flex-start"><CatalogSearch placeholder={t("modelAdmin.search")} value={query} onChange={value => { setQuery(value); setPage(1); }} resultCount={filtered.length} totalCount={models?.length ?? 0} />
        <Select aria-label={t("models.type")} placeholder={t("models.type")} clearable value={type} data={REGISTRY_MODEL_TYPES.map(value => ({ value, label: t(`models.type.${value}`) }))} onChange={value => { setType(value); setPage(1); }} />
        <Select aria-label={t("modelAdmin.providers")} placeholder={t("modelAdmin.providers")} clearable value={provider} data={[...new Set(models.map(model => model.provider))]} onChange={value => { setProvider(value); setPage(1); }} /></Group>
      {!models.length && <EmptyState>{t("models.empty")}</EmptyState>}
      {models.length > 0 && filtered.length === 0 && <EmptyState>{t("settings.noResults")}</EmptyState>}
      {!!filtered.length && <DataTable minWidth={520}><Table.Thead><Table.Tr><Table.Th>{t("modelAdmin.name")}</Table.Th><Table.Th>{t("models.type")}</Table.Th><Table.Th>{t("modelAdmin.providers")}</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{filtered.slice((Math.min(page, pages) - 1) * 25, Math.min(page, pages) * 25).map(model => <Table.Tr key={model.id}>
          <Table.Td><Text fw={500}>{model.displayName}</Text><Text size="xs" c="dimmed">{model.wireId}</Text></Table.Td>
          <Table.Td><Badge variant="light">{t(`models.type.${model.type}`)}</Badge></Table.Td><Table.Td>{model.provider}</Table.Td>
        </Table.Tr>)}</Table.Tbody></DataTable>}
      {pages > 1 && <Pagination total={pages} value={Math.min(page, pages)} onChange={setPage} />}
    </>}
  </Stack>;
}
