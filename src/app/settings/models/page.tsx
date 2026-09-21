"use client";

import { useEffect, useRef, useState } from "react";
import { useLocalStorage } from "@mantine/hooks";
import { Alert, Badge, Button, Card, Group, Select, Stack, Text, TextInput } from "@mantine/core";
import { LoadingText, EmptyState } from "@/app/_components/PageState";
import { SectionHeading } from "@/app/_components/SectionHeading";
import { useConfirm } from "@/app/_components/useConfirm";
import { useT } from "@/app/_i18n/provider";
import { readJson } from "@/app/_lib/httpClient";
import { ModelCollection } from "@/app/models/ModelCollection";
import { MODEL_BROWSER_KEYS, deserializeModelProvider } from "@/app/models/modelTable";
import { REGISTRY_MODEL_TYPES, registrationFromDiscovery, type DiscoveredModel, type RegisteredModel, type RegistryModelType } from "@/domain/llm/providerModels";
import type { SettingsView } from "@/application/settings/settingsUseCases";
import { deleteRegisteredModel, discoverProviderModels, listRegisteredModels, saveRegisteredModel } from "@/app/models/api";

export default function ModelSelectionPage() {
  const t = useT();
  const [providers, setProviders] = useState<SettingsView["llmProviders"]["items"]>();
  const [savedProvider, setProvider] = useLocalStorage<string | null>({
    key: MODEL_BROWSER_KEYS.activeProvider, defaultValue: null, deserialize: deserializeModelProvider, sync: false,
  });
  const provider = providers?.some(item => item.name === savedProvider) ? savedProvider : providers?.[0]?.name ?? null;
  // Each entry is a complete provider response. UI filters never mutate this source.
  const [catalogs, setCatalogs] = useState(() => new Map<string, DiscoveredModel[]>());
  const models = provider ? catalogs.get(provider) : undefined;
  const [registered, setRegistered] = useState<RegisteredModel[]>([]);
  const [chosenTypes, setChosenTypes] = useState(() => new Map<string, RegistryModelType>());
  const [manual, setManual] = useState(false);
  const [manualId, setManualId] = useState("");
  const [manualType, setManualType] = useState<RegistryModelType>("text");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<string>();
  const [removing, setRemoving] = useState<string>();
  const pending = !!adding || !!removing;
  const { confirm, confirmModal } = useConfirm();
  const generation = useRef(0);
  useEffect(() => {
    let current = true;
    void Promise.all([
      fetch("/api/settings").then(response => readJson<SettingsView>(response)),
      listRegisteredModels(),
    ]).then(([settings, selection]) => {
      if (!current) return;
      setProviders(settings.llmProviders.items); setRegistered(selection);
    }).catch(error => { if (current) setError(error instanceof Error ? error.message : "Could not load models"); });
    return () => { current = false; generation.current++; };
  }, []);
  async function discover() {
    if (!provider || busy || pending) return;
    const request = ++generation.current;
    setBusy(true); setError(undefined);
    try {
      const result = await discoverProviderModels(provider);
      if (request === generation.current) setCatalogs(previous => new Map(previous).set(provider, result));
    } catch (error) { if (request === generation.current) setError(error instanceof Error ? error.message : "Could not discover models"); }
    finally { if (request === generation.current) setBusy(false); }
  }
  async function register(model: DiscoveredModel) {
    if (!provider || pending) return;
    setAdding(model.wireId); setError(undefined);
    try {
      const result = await saveRegisteredModel(registrationFromDiscovery(provider, model));
      setRegistered(result); setManual(false); setManualId("");
    } catch (error) { setError(error instanceof Error ? error.message : "Could not register model"); }
    finally { setAdding(undefined); }
  }
  async function remove(model: RegisteredModel) {
    if (pending || !await confirm({ title: t("modelAdmin.deleteModel"), message: t("modelAdmin.deleteModelHint"), confirmLabel: t("modelAdmin.delete") })) return;
    setRemoving(model.wireId); setError(undefined);
    try {
      await deleteRegisteredModel(model.id);
      setRegistered(previous => previous.filter(item => item.id !== model.id));
    } catch (error) { setError(error instanceof Error ? error.message : "Could not delete model"); }
    finally { setRemoving(undefined); }
  }
  const selectedModels = registered.filter(model => model.provider === provider);
  const selectedById = new Map(selectedModels.map(model => [model.wireId, model]));
  const selected = new Set(selectedById.keys());
  const catalogRows: DiscoveredModel[] = [
    ...(models ?? []).map(model => selectedById.get(model.wireId) ?? model),
    ...selectedModels.filter(model => !models?.some(item => item.wireId === model.wireId)),
  ];
  const types = REGISTRY_MODEL_TYPES.map(value => ({ value, label: t(`models.type.${value}`) }));
  return <Stack gap="lg">
    {confirmModal}
    <SectionHeading title={t("modelAdmin.selection")} description={t("modelAdmin.selectionHint")} />
    {error && <Alert color="red">{error}</Alert>}
    {!providers && !error && <LoadingText />}
    {providers && !providers.length && <EmptyState>{t("modelAdmin.emptyProviders")}</EmptyState>}
    {!!providers?.length && <>
      <Group align="flex-end">
        <Select label={t("modelAdmin.providers")} value={provider} allowDeselect={false} disabled={pending}
          data={providers.map(item => ({ value: item.name, label: `${item.name} (${item.kind})` }))}
          onChange={value => { generation.current++; setProvider(value); setBusy(false); setError(undefined); setChosenTypes(new Map()); setManual(false); }} />
        <Button onClick={() => void discover()} loading={busy} disabled={pending}>{t("modelAdmin.discover")}</Button>
        <Button variant="default" disabled={!provider || pending} onClick={() => setManual(!manual)}>{t("modelAdmin.manual")}</Button>
      </Group>
      {manual && <Card><form onSubmit={event => { event.preventDefault(); void register({ wireId: manualId.trim(), displayName: manualId.trim(), type: manualType }); }}>
        <Stack gap="md"><TextInput label={t("modelAdmin.wireId")} value={manualId} required onChange={event => setManualId(event.currentTarget.value)} disabled={!!adding} />
          <Select label={t("models.type")} value={manualType} data={types} allowDeselect={false} onChange={value => { if (value) setManualType(value as RegistryModelType); }} disabled={!!adding} />
          <Text size="sm" c="dimmed">{t("modelAdmin.manualHint")}</Text>
          <Group><Button type="submit" loading={!!adding} disabled={!manualId.trim()}>{t("modelAdmin.add")}</Button>
            <Button variant="default" disabled={!!adding} onClick={() => setManual(false)}>{t("common.cancel")}</Button></Group>
        </Stack>
      </form></Card>}
      <>
        <Text size="xs" c="dimmed">{t("modelAdmin.factsHint")}</Text>
        <ModelCollection scope="discovery" models={catalogRows} provider={provider ?? undefined} emptyText={t(models ? "modelAdmin.discoveryEmpty" : "modelAdmin.discoverHint")}
          isSelected={model => selected.has(model.wireId)}
          renderActions={model => selected.has(model.wireId) ? <>
            <Badge color="teal">{t("modelAdmin.enabled")}</Badge>
            <Button color="red" variant="subtle" disabled={pending} loading={removing === model.wireId}
              onClick={() => { const item = selectedModels.find(item => item.wireId === model.wireId); if (item) void remove(item); }}>{t("modelAdmin.delete")}</Button>
          </> : <>
            {!model.type && !model.outputModalities?.length && <Select aria-label={`${model.displayName} ${t("models.type")}`} placeholder={t("modelAdmin.chooseType")}
              value={chosenTypes.get(model.wireId) ?? null} data={types} disabled={pending} onChange={value => { if (value) setChosenTypes(previous => new Map(previous).set(model.wireId, value as RegistryModelType)); }} />}
            {!model.type && !!model.outputModalities?.length ? <Text size="xs" c="dimmed">{t("modelAdmin.unsupportedType")}</Text> : <Button variant="light"
              disabled={pending || !(model.type ?? chosenTypes.get(model.wireId))} loading={adding === model.wireId}
              onClick={() => void register({ ...model, type: model.type ?? chosenTypes.get(model.wireId) })}>{t("modelAdmin.add")}</Button>}
          </>} />
      </>
    </>}
  </Stack>;
}
