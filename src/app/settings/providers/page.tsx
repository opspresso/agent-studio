"use client";

import { SecretInput } from "@/app/_components/SecretInput";
import { DataTable } from "@/app/_components/DataTable";
import { LoadingText, EmptyState } from "@/app/_components/PageState";
import { SectionHeading } from "@/app/_components/SectionHeading";
import { useEffect, useState } from "react";
import { Alert, Button, Group, Select, Stack, Table, Text, TextInput } from "@mantine/core";
import { FormModal } from "@/app/_components/FormModal";
import { useConfirm } from "@/app/_components/useConfirm";
import { useT } from "@/app/_i18n/provider";
import { readJson, jsonHeaders } from "@/app/_lib/httpClient";
import { SUPPORTED_PROVIDERS, type SupportedProvider } from "@/domain/llm/models";
import type { LlmProviderInput, SettingsView } from "@/application/settings/settingsUseCases";

const empty = (): LlmProviderInput => ({ name: "", kind: "openai", baseUrl: "", apiKey: "", auth: "bearer" });

export default function ProvidersPage() {
  const t = useT();
  const [view, setView] = useState<SettingsView>();
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<LlmProviderInput>(empty);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const { confirm, confirmModal } = useConfirm();
  useEffect(() => {
    let current = true;
    void fetch("/api/settings").then(response => readJson<SettingsView>(response))
      .then(value => { if (current) setView(value); })
      .catch(error => { if (current) setError(error instanceof Error ? error.message : "Could not load providers"); });
    return () => { current = false; };
  }, []);

  async function save(providers: LlmProviderInput[]) {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      setView(await readJson<SettingsView>(await fetch("/api/settings", { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ llmProviders: providers }) })));
      setEditing(null);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save providers"); }
    finally { setBusy(false); }
  }
  async function remove(name: string) {
    if (!view || !await confirm({ title: t("modelAdmin.deleteProvider"), message: t("modelAdmin.deleteProviderHint"), confirmLabel: t("modelAdmin.delete") })) return;
    await save(view.llmProviders.items.filter(provider => provider.name !== name));
  }

  return <Stack gap="lg">
    <SectionHeading title={t("modelAdmin.providers")} description={t("modelAdmin.providerHint")}>
      <Button disabled={!view || busy} onClick={() => { setForm(empty()); setEditing(""); setError(undefined); }}>{t("modelAdmin.addProvider")}</Button>
    </SectionHeading>
    {confirmModal}
    {error && editing === null && <Alert color="red">{error}</Alert>}
    {!view && !error && <LoadingText />}
    {view && (view.llmProviders.items.length ? <DataTable minWidth={600}>
      <Table.Thead><Table.Tr><Table.Th>{t("modelAdmin.name")}</Table.Th><Table.Th>{t("modelAdmin.kind")}</Table.Th><Table.Th>{t("modelAdmin.url")}</Table.Th><Table.Th /></Table.Tr></Table.Thead>
      <Table.Tbody>{view.llmProviders.items.map(provider => <Table.Tr key={provider.name}>
        <Table.Td><Text fw={600}>{provider.name}</Text></Table.Td><Table.Td>{provider.kind}</Table.Td>
        <Table.Td><Text size="sm" style={{ overflowWrap: "anywhere" }}>{provider.baseUrl}</Text></Table.Td>
        <Table.Td><Group gap="xs" wrap="nowrap"><Button variant="subtle" disabled={busy} onClick={() => { setForm({ ...provider }); setEditing(provider.name); setError(undefined); }}>{t("modelAdmin.edit")}</Button>
          <Button color="red" variant="subtle" disabled={busy} onClick={() => void remove(provider.name)}>{t("modelAdmin.delete")}</Button></Group></Table.Td>
      </Table.Tr>)}</Table.Tbody>
    </DataTable> : <EmptyState>{t("modelAdmin.emptyProviders")}</EmptyState>)}
    <FormModal opened={editing !== null} onClose={() => setEditing(null)} title={t(editing ? "modelAdmin.edit" : "modelAdmin.addProvider")}
      error={error ?? null} submitting={busy} submitLabel={t("modelAdmin.save")} submitDisabled={!view || !form.name.trim() || !form.baseUrl.trim()}
      onSubmit={() => {
        if (!view) return;
        void save(editing ? view.llmProviders.items.map(provider => provider.name === editing ? form : provider) : [...view.llmProviders.items, form]);
      }}>
        <TextInput label={t("modelAdmin.name")} value={form.name} disabled={!!editing || busy} required onChange={event => setForm({ ...form, name: event.currentTarget.value })} />
        <Select label={t("modelAdmin.kind")} data={[...SUPPORTED_PROVIDERS]} value={form.kind} disabled={busy} allowDeselect={false} onChange={kind => { if (kind) setForm({ ...form, kind: kind as SupportedProvider }); }} />
        <TextInput type="url" label={t("modelAdmin.url")} placeholder="https://api.example.com/v1" value={form.baseUrl} required disabled={busy} onChange={event => setForm({ ...form, baseUrl: event.currentTarget.value })} />
        <SecretInput label={t("modelAdmin.key")} description={t("modelAdmin.keyHint")} value={form.apiKey} storedValue={view?.llmProviders.items.find(provider => provider.name === editing)?.apiKey} disabled={busy} onChange={apiKey => setForm({ ...form, apiKey })} />
    </FormModal>
  </Stack>;
}
