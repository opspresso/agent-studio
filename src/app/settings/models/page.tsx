"use client";

import { CatalogSearch, matchesFilter } from "@/app/_components/CatalogSearch";
import { DataTable } from "@/app/_components/DataTable";
import { LoadingText, EmptyState } from "@/app/_components/PageState";
import { SectionHeading } from "@/app/_components/SectionHeading";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Group, Pagination, Select, Stack, Table, Text } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { readJson } from "@/app/_lib/httpClient";
import { REGISTRY_MODEL_TYPES, type DiscoveredModel, type RegisteredModel } from "@/domain/llm/providerModels";
import type { SettingsView } from "@/application/settings/settingsUseCases";
import type { ModelRegistryResponse } from "@/app/api/models/registry/route";
import type { ModelDiscoveryResponse } from "@/app/api/models/discover/route";
import { ModelRegistrationForm } from "@/app/models/ModelRegistrationForm";

export default function ModelSelectionPage() {
  const t = useT();
  const [providers, setProviders] = useState<SettingsView["llmProviders"]["items"]>();
  const [provider, setProvider] = useState<string | null>(null);
  const [models, setModels] = useState<DiscoveredModel[]>();
  const [registered, setRegistered] = useState<RegisteredModel[]>([]);
  const [editing, setEditing] = useState<{ candidate?: DiscoveredModel }>();
  const [query, setQuery] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    let current = true;
    void Promise.all([
      fetch("/api/settings").then(response => readJson<SettingsView>(response)),
      fetch("/api/models/registry").then(response => readJson<ModelRegistryResponse>(response)),
    ]).then(([settings, selection]) => {
      if (!current) return;
      setProviders(settings.llmProviders.items); setProvider(settings.llmProviders.items[0]?.name ?? null); setRegistered(selection.models);
    }).catch(error => { if (current) setError(error instanceof Error ? error.message : "Could not load models"); });
    return () => { current = false; generation.current++; };
  }, []);
  async function discover() {
    if (!provider || busy) return;
    const request = ++generation.current;
    setBusy(true); setError(undefined); setModels(undefined);
    try {
      const result = await readJson<ModelDiscoveryResponse>(await fetch(`/api/models/discover?provider=${encodeURIComponent(provider)}`));
      if (request === generation.current) { setModels(result.models); setPage(1); }
    } catch (error) { if (request === generation.current) setError(error instanceof Error ? error.message : "Could not discover models"); }
    finally { if (request === generation.current) setBusy(false); }
  }
  const filtered = useMemo(() => (models ?? []).filter(model => (!type || model.type === type) && matchesFilter(query, model.wireId, model.displayName)), [models, query, type]);
  const selected = new Set(registered.filter(model => model.provider === provider).map(model => model.wireId));
  const totalPages = Math.max(1, Math.ceil(filtered.length / 30));
  return <Stack gap="lg">
    <SectionHeading title={t("modelAdmin.selection")} description={t("modelAdmin.selectionHint")} />
    {error && <Alert color="red">{error}</Alert>}
    {!providers && !error && <LoadingText />}
    {providers && !providers.length && <EmptyState>{t("modelAdmin.emptyProviders")}</EmptyState>}
    {!!providers?.length && <>
      <Group align="flex-end"><Select label={t("modelAdmin.providers")} value={provider} allowDeselect={false} data={providers.map(item => ({ value: item.name, label: `${item.name} (${item.kind})` }))}
        onChange={value => { generation.current++; setProvider(value); setModels(undefined); setBusy(false); setError(undefined); setPage(1); }} />
        <Button onClick={() => void discover()} loading={busy}>{t("modelAdmin.discover")}</Button>
        <Button variant="default" disabled={!provider} onClick={() => setEditing({})}>{t("modelAdmin.manual")}</Button></Group>
      {models && <>
        <Group align="flex-start"><CatalogSearch placeholder={t("modelAdmin.search")} value={query} onChange={value => { setQuery(value); setPage(1); }} resultCount={filtered.length} totalCount={models?.length ?? 0} />
          <Select aria-label={t("models.type")} placeholder={t("models.type")} value={type} clearable data={REGISTRY_MODEL_TYPES.map(value => ({ value, label: t(`models.type.${value}`) }))} onChange={value => { setType(value); setPage(1); }} /></Group>
        {!models.length && <EmptyState>{t("modelAdmin.discoveryEmpty")}</EmptyState>}
        {models.length > 0 && !filtered.length && <EmptyState>{t("settings.noResults")}</EmptyState>}
        {!!filtered.length && <DataTable minWidth={560}><Table.Thead><Table.Tr><Table.Th>{t("modelAdmin.name")}</Table.Th><Table.Th>{t("models.type")}</Table.Th><Table.Th /></Table.Tr></Table.Thead>
          <Table.Tbody>{filtered.slice((Math.min(page, totalPages) - 1) * 30, Math.min(page, totalPages) * 30).map(model => <Table.Tr key={model.wireId}>
            <Table.Td><Text fw={500}>{model.displayName}</Text><Text size="xs" c="dimmed">{model.wireId}</Text></Table.Td>
            <Table.Td>{model.type ? t(`models.type.${model.type}`) : t("modelAdmin.unknownType")}</Table.Td>
            <Table.Td>{selected.has(model.wireId) ? <Badge>{t("modelAdmin.enabled")}</Badge> : <Button variant="light" onClick={() => setEditing({ candidate: model })}>{t("modelAdmin.select")}</Button>}</Table.Td>
          </Table.Tr>)}</Table.Tbody></DataTable>}
        {totalPages > 1 && <Pagination total={totalPages} value={Math.min(page, totalPages)} onChange={setPage} />}
      </>}
    </>}
      {editing && provider && <ModelRegistrationForm key={`${provider}/${editing.candidate?.wireId ?? "new"}`} provider={provider} candidate={editing.candidate}
        onSaved={models => { setRegistered(models); setEditing(undefined); }} onCancel={() => setEditing(undefined)} />}
  </Stack>;
}
