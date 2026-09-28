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
import { ModelEditor } from "@/app/models/ModelEditor";
import { MODEL_BROWSER_KEYS, deserializeModelProvider } from "@/app/models/modelTable";
import { REGISTRY_MODEL_TYPES, providerKind, registrationFromDiscovery, type DiscoveredModel, type RegisteredModel, type RegistryModelType } from "@/domain/llm/providerModels";
import type { SettingsView } from "@/application/settings/settingsUseCases";
import type { RegisteredModelView } from "@/application/llm/modelRegistry";
import { checkRegisteredModel, deleteRegisteredModel, discoverProviderModels, listRegisteredModels, saveRegisteredModel } from "@/app/models/api";

export default function ModelManagementPage() {
  const t = useT();
  const [providers, setProviders] = useState<SettingsView["llmProviders"]["items"]>();
  const [savedProvider, setProvider] = useLocalStorage<string | null>({
    key: MODEL_BROWSER_KEYS.activeProvider, defaultValue: null, deserialize: deserializeModelProvider, sync: false,
  });
  // Each entry is a complete provider response. UI filters never mutate this source.
  const [catalogs, setCatalogs] = useState(() => new Map<string, DiscoveredModel[]>());
  const [registered, setRegistered] = useState<RegisteredModelView[]>([]);
  const connections = new Map(providers?.map(item => [item.name, item]));
  const providerNames = [...new Set([...connections.keys(), ...registered.map(model => model.provider)])];
  const provider = savedProvider && providerNames.includes(savedProvider) ? savedProvider : providerNames[0] ?? null;
  const connection = provider ? connections.get(provider) : undefined;
  const manualAllowed = connection !== undefined && providerKind(connection) === "selfhosted";
  const models = provider ? catalogs.get(provider) : undefined;
  const [chosenTypes, setChosenTypes] = useState(() => new Map<string, RegistryModelType>());
  const [manual, setManual] = useState(false);
  const [manualId, setManualId] = useState("");
  const [manualType, setManualType] = useState<RegistryModelType>("text");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<string>();
  const [removing, setRemoving] = useState<string>();
  const [checking, setChecking] = useState<string>();
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<RegisteredModelView>();
  const pending = busy || !!adding || !!removing || !!checking || !!editing;
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
    if (!connection || pending) return;
    const request = ++generation.current;
    setBusy(true); setError(undefined);
    try {
      const result = await discoverProviderModels(connection.name);
      if (request !== generation.current) return;
      // Provider discovery remains usable even when the registry refresh fails.
      setCatalogs(previous => new Map(previous).set(connection.name, result));
      const selection = await listRegisteredModels();
      if (request === generation.current) {
        setRegistered(selection);
      }
    } catch (error) { if (request === generation.current) setError(error instanceof Error ? error.message : "Could not discover models"); }
    finally { if (request === generation.current) setBusy(false); }
  }
  async function register(model: DiscoveredModel) {
    if (!connection || pending) return;
    setAdding(model.wireId); setError(undefined);
    try {
      const result = await saveRegisteredModel(registrationFromDiscovery(connection.name, model));
      setRegistered(result); setManual(false); setManualId("");
    } catch (error) { setError(error instanceof Error ? error.message : "Could not register model"); }
    finally { setAdding(undefined); }
  }
  async function remove(model: RegisteredModel) {
    if (pending || !await confirm({ title: t("modelAdmin.deleteModel"), message: t("modelAdmin.deleteModelHint"), confirmLabel: t("modelAdmin.delete") })) return;
    setRemoving(model.id); setError(undefined);
    try {
      await deleteRegisteredModel(model.id);
      setRegistered(previous => previous.filter(item => item.id !== model.id));
    } catch (error) { setError(error instanceof Error ? error.message : "Could not delete model"); }
    finally { setRemoving(undefined); }
  }
  async function check(model: RegisteredModelView) {
    if (pending) return;
    setChecking(model.id); setError(undefined);
    try {
      const result = await checkRegisteredModel(model.id);
      setStatuses(previous => ({ ...previous, [model.id]: result.available ? t("modelAdmin.available") : t("modelAdmin.missing") }));
    } catch (error) {
      setStatuses(previous => ({ ...previous, [model.id]: error instanceof Error ? error.message : "Status check failed" }));
    } finally { setChecking(undefined); }
  }
  const selectedModels = registered.filter(model => model.provider === provider);
  const selectedById = new Map(selectedModels.map(model => [model.id, model]));
  const selected = new Set(selectedById.keys());
  const identity = (model: DiscoveredModel) => model.id ?? `${provider}/${model.wireId}`;
  const catalogRows: DiscoveredModel[] = [
    ...(models ?? []).map(model => selectedById.get(identity(model)) ?? model),
    ...selectedModels.filter(model => !models?.some(item => identity(item) === model.id)),
  ];
  const types = REGISTRY_MODEL_TYPES.map(value => ({ value, label: t(`models.type.${value}`) }));
  return <Stack gap="lg">
    {confirmModal}
    <SectionHeading title={t("modelAdmin.selection")} description={t("modelAdmin.selectionHint")} />
    {error && <Alert color="red">{error}</Alert>}
    {!providers && !error && <LoadingText />}
    {providers && !providerNames.length && <EmptyState>{t("modelAdmin.emptyProviders")}</EmptyState>}
    {!!providerNames.length && <>
      <Group align="flex-end">
        <Select label={t("modelAdmin.providers")} value={provider} allowDeselect={false} disabled={pending}
          data={providerNames.map(name => {
            const item = connections.get(name);
            return { value: name, label: item ? `${name} (${item.kind})` : name };
          })}
          onChange={value => { generation.current++; setProvider(value); setBusy(false); setError(undefined); setChosenTypes(new Map()); setManual(false); }} />
        <Button onClick={() => void discover()} loading={busy} disabled={!connection || pending}>{t("modelAdmin.discover")}</Button>
        {manualAllowed && <Button variant="default" disabled={pending} onClick={() => setManual(!manual)}>{t("modelAdmin.manual")}</Button>}
      </Group>
      {manual && <Card><form onSubmit={event => { event.preventDefault(); void register({ wireId: manualId.trim(), displayName: manualId.trim(), type: manualType }); }}>
        <Stack gap="md"><TextInput label={t("modelAdmin.wireId")} value={manualId} required onChange={event => setManualId(event.currentTarget.value)} disabled={pending} />
          <Select label={t("models.type")} value={manualType} data={types} allowDeselect={false} onChange={value => { if (value) setManualType(value as RegistryModelType); }} disabled={pending} />
          <Text size="sm" c="dimmed">{t("modelAdmin.manualHint")}</Text>
          <Group><Button type="submit" loading={!!adding} disabled={pending || !manualId.trim()}>{t("modelAdmin.add")}</Button>
            <Button variant="default" disabled={pending} onClick={() => setManual(false)}>{t("common.cancel")}</Button></Group>
        </Stack>
      </form></Card>}
      <>
        <Text size="xs" c="dimmed">{t("modelAdmin.factsHint")}</Text>
        <ModelCollection scope="discovery" models={catalogRows} provider={provider ?? undefined} emptyText={t(models ? "modelAdmin.discoveryEmpty" : "modelAdmin.discoverHint")}
          isSelected={model => selected.has(identity(model))}
          renderActions={model => selected.has(identity(model)) ? <>
            {statuses[identity(model)] && <Text size="xs" role="status" w="100%">{statuses[identity(model)]}</Text>}
            <Badge color="teal">{t("modelAdmin.enabled")}</Badge>
            <Button variant="default" disabled={pending} loading={checking === identity(model)}
              onClick={() => { const item = selectedById.get(identity(model)); if (item) void check(item); }}>{t("modelAdmin.check")}</Button>
            <Button variant="default" disabled={pending}
              onClick={() => setEditing(selectedById.get(identity(model)))}>{t("modelAdmin.edit")}</Button>
            <Button color="red" variant="subtle" disabled={pending} loading={removing === identity(model)}
              onClick={() => { const item = selectedById.get(identity(model)); if (item) void remove(item); }}>{t("modelAdmin.delete")}</Button>
          </> : <>
            {!model.type && !model.outputModalities?.length && <Select aria-label={`${model.displayName} ${t("models.type")}`} placeholder={t("modelAdmin.chooseType")}
              value={chosenTypes.get(model.wireId) ?? null} data={types} disabled={pending} onChange={value => { if (value) setChosenTypes(previous => new Map(previous).set(model.wireId, value as RegistryModelType)); }} />}
            {!model.type && !!model.outputModalities?.length ? <Text size="xs" c="dimmed">{t("modelAdmin.unsupportedType")}</Text> : <Button variant="light"
              disabled={pending || !(model.type ?? chosenTypes.get(model.wireId))} loading={adding === model.wireId}
              onClick={() => void register({ ...model, type: model.type ?? chosenTypes.get(model.wireId) })}>{t("modelAdmin.add")}</Button>}
          </>} />
      </>
      {editing && <ModelEditor key={editing.id} model={editing} onSaved={models => { setRegistered(models); setEditing(undefined); setError(undefined); }} onCancel={() => setEditing(undefined)} />}
    </>}
  </Stack>;
}
