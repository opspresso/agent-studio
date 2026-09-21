"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Badge, Group, Loader, Pagination, Select, Stack, Table, Text, TextInput } from "@mantine/core";
import { IconCpu } from "@tabler/icons-react";
import { CatalogHeader } from "@/app/_components/CatalogHeader";
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
  const filtered = useMemo(() => (models ?? []).filter(model => (!type || model.type === type) && (!provider || model.provider === provider) && `${model.displayName} ${model.id}`.toLowerCase().includes(query.toLowerCase())), [models, type, provider, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / 25));
  return <Stack gap="lg">
    <CatalogHeader title={t("nav.models")} description={t("modelAdmin.onlySelected")} Icon={IconCpu} />
    {error && <Alert color="red">{error}</Alert>}
    {!models && !error && <Loader />}
    {models && <>
      <Group align="flex-end"><TextInput aria-label={t("modelAdmin.search")} placeholder={t("modelAdmin.search")} value={query} style={{ flex: 1 }} onChange={event => { setQuery(event.currentTarget.value); setPage(1); }} />
        <Select aria-label={t("models.type")} placeholder={t("models.type")} clearable value={type} data={REGISTRY_MODEL_TYPES.map(value => ({ value, label: t(`models.type.${value}`) }))} onChange={value => { setType(value); setPage(1); }} />
        <Select aria-label={t("modelAdmin.providers")} placeholder={t("modelAdmin.providers")} clearable value={provider} data={[...new Set(models.map(model => model.provider))]} onChange={value => { setProvider(value); setPage(1); }} /></Group>
      {!models.length && <Text c="dimmed">{t("models.empty")}</Text>}
      {models.length > 0 && filtered.length === 0 && <Text c="dimmed">{t("settings.noResults")}</Text>}
      {!!filtered.length && <Table.ScrollContainer minWidth={520}><Table verticalSpacing="md"><Table.Thead><Table.Tr><Table.Th>{t("modelAdmin.name")}</Table.Th><Table.Th>{t("models.type")}</Table.Th><Table.Th>{t("modelAdmin.providers")}</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{filtered.slice((Math.min(page, pages) - 1) * 25, Math.min(page, pages) * 25).map(model => <Table.Tr key={model.id}>
          <Table.Td><Text fw={500}>{model.displayName}</Text><Text size="xs" c="dimmed">{model.wireId}</Text></Table.Td>
          <Table.Td><Badge variant="light">{t(`models.type.${model.type}`)}</Badge></Table.Td><Table.Td>{model.provider}</Table.Td>
        </Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>}
      {pages > 1 && <Pagination total={pages} value={Math.min(page, pages)} onChange={setPage} />}
    </>}
  </Stack>;
}
