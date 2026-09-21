"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Group, Loader, Modal, Pagination, Select, Stack, Table, Text, TextInput } from "@mantine/core";
import { IconCpu } from "@tabler/icons-react";
import { CatalogHeader } from "@/app/_components/CatalogHeader";
import { useConfirm } from "@/app/_components/useConfirm";
import { useT } from "@/app/_i18n/provider";
import { readJson, assertOk } from "@/app/_lib/httpClient";
import { useViewer } from "@/app/_lib/useViewer";
import { ModelSettingsNav } from "@/app/settings/ModelSettingsNav";
import { ModelRegistrationForm } from "./ModelRegistrationForm";
import { REGISTRY_MODEL_TYPES, type RegisteredModel } from "@/domain/llm/providerModels";
import type { ModelRegistryResponse } from "@/app/api/models/registry/route";
import type { ModelStatusResponse } from "@/app/api/models/status/route";

export default function ModelsPage() {
  const t = useT();
  const viewer = useViewer();
  const [models, setModels] = useState<RegisteredModel[]>();
  const [query, setQuery] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<RegisteredModel>();
  const { confirm, confirmModal } = useConfirm();
  const load = useCallback(async () => (await readJson<ModelRegistryResponse>(await fetch("/api/models/registry"))).models, []);
  useEffect(() => {
    let current = true;
    void load().then(value => { if (current) setModels(value); }).catch(error => { if (current) setError(error instanceof Error ? error.message : "Could not load models"); });
    return () => { current = false; };
  }, [load]);
  async function remove(model: RegisteredModel) {
    if (busy || !await confirm({ title: t("modelAdmin.deleteModel"), message: t("modelAdmin.deleteModelHint"), confirmLabel: t("modelAdmin.delete") })) return;
    setBusy(model.id); setError(undefined);
    try { await assertOk(await fetch(`/api/models/registry?id=${encodeURIComponent(model.id)}`, { method: "DELETE" })); setModels(await load()); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not delete model"); }
    finally { setBusy(undefined); }
  }
  async function check(model: RegisteredModel) {
    if (busy) return;
    setBusy(model.id); setError(undefined);
    try {
      const result = await readJson<ModelStatusResponse>(await fetch(`/api/models/status?id=${encodeURIComponent(model.id)}`));
      setStatuses(previous => ({ ...previous, [model.id]: result.available ? t("modelAdmin.available") : t("modelAdmin.missing") }));
    } catch (error) { setStatuses(previous => ({ ...previous, [model.id]: error instanceof Error ? error.message : "Status check failed" })); }
    finally { setBusy(undefined); }
  }
  const filtered = useMemo(() => (models ?? []).filter(model => (!type || model.type === type) && (!provider || model.provider === provider) && `${model.displayName} ${model.id}`.toLowerCase().includes(query.toLowerCase())), [models, type, provider, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / 25));
  const canEdit = viewer?.isAdmin === true;
  return <Stack gap="lg">
    <CatalogHeader title={t("nav.models")} description={t("modelAdmin.onlySelected")} Icon={IconCpu} />
    {canEdit && <ModelSettingsNav />}
    {confirmModal}
    {error && <Alert color="red">{error}</Alert>}
    {!models && !error && <Loader />}
    {models && <>
      <Group align="flex-end"><TextInput aria-label={t("modelAdmin.search")} placeholder={t("modelAdmin.search")} value={query} style={{ flex: 1 }} onChange={event => { setQuery(event.currentTarget.value); setPage(1); }} />
        <Select aria-label={t("models.type")} placeholder={t("models.type")} clearable value={type} data={REGISTRY_MODEL_TYPES.map(value => ({ value, label: t(`models.type.${value}`) }))} onChange={value => { setType(value); setPage(1); }} />
        <Select aria-label={t("modelAdmin.providers")} placeholder={t("modelAdmin.providers")} clearable value={provider} data={[...new Set(models.map(model => model.provider))]} onChange={value => { setProvider(value); setPage(1); }} /></Group>
      {!models.length && <Text c="dimmed">{t("modelAdmin.emptyModels")}</Text>}
      {!!models.length && <Table.ScrollContainer minWidth={680}><Table verticalSpacing="md"><Table.Thead><Table.Tr><Table.Th>{t("modelAdmin.name")}</Table.Th><Table.Th>{t("models.type")}</Table.Th><Table.Th>{t("modelAdmin.providers")}</Table.Th>{canEdit && <Table.Th />}</Table.Tr></Table.Thead>
        <Table.Tbody>{filtered.slice((Math.min(page, pages) - 1) * 25, Math.min(page, pages) * 25).map(model => <Table.Tr key={model.id}>
          <Table.Td><Text fw={500}>{model.displayName}</Text><Text size="xs" c="dimmed">{model.wireId}</Text>{statuses[model.id] && <Text size="xs">{statuses[model.id]}</Text>}</Table.Td>
          <Table.Td><Badge variant="light">{t(`models.type.${model.type}`)}</Badge></Table.Td><Table.Td>{model.provider}</Table.Td>
          {canEdit && <Table.Td><Group gap="xs" justify="flex-end"><Button variant="subtle" disabled={!!busy} loading={busy === model.id} onClick={() => void check(model)}>{t("modelAdmin.check")}</Button>
            <Button variant="subtle" disabled={!!busy} onClick={() => setEditing(model)}>{t("modelAdmin.edit")}</Button>
            <Button variant="subtle" color="red" disabled={!!busy} onClick={() => void remove(model)}>{t("modelAdmin.delete")}</Button></Group></Table.Td>}
        </Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>}
      {pages > 1 && <Pagination total={pages} value={Math.min(page, pages)} onChange={setPage} />}
    </>}
    <Modal opened={!!editing} onClose={() => setEditing(undefined)} title={t("modelAdmin.confirmModel")} size="lg">
      {editing && <ModelRegistrationForm key={editing.id} provider={editing.provider} candidate={editing} onSaved={models => { setModels(models); setEditing(undefined); }} onCancel={() => setEditing(undefined)} />}
    </Modal>
  </Stack>;
}
