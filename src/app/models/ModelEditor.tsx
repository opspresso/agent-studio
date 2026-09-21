"use client";

import { useState } from "react";
import { Checkbox, NumberInput, Select, SimpleGrid, Text, TextInput } from "@mantine/core";
import { FormModal } from "@/app/_components/FormModal";
import { useT } from "@/app/_i18n/provider";
import { REGISTRY_MODEL_TYPES, registrationFromDiscovery, type RegisteredModel, type RegistryModelType } from "@/domain/llm/providerModels";
import { saveRegisteredModel } from "./api";

export function ModelEditor({ model, onSaved, onCancel }: {
  model: RegisteredModel;
  onSaved(models: RegisteredModel[]): void;
  onCancel(): void;
}) {
  const t = useT();
  const [form, setForm] = useState(() => ({ ...model, pricing: model.pricing ?? { inputPer1M: 0, outputPer1M: 0 } }));
  const [priced, setPriced] = useState(model.pricing !== undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function save() {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      onSaved(await saveRegisteredModel(registrationFromDiscovery(model.provider, {
        ...form, displayName: form.displayName.trim(), pricing: priced ? form.pricing : undefined,
        outputModalities: form.type === model.type ? model.outputModalities : undefined,
      })));
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save model"); }
    finally { setBusy(false); }
  }
  return <FormModal opened onClose={onCancel} title={t("modelAdmin.confirmModel")} error={error ?? null}
    submitting={busy} submitLabel={t("modelAdmin.save")} submitDisabled={!form.wireId.trim() || !form.displayName.trim()} onSubmit={() => void save()}>
    <Text size="sm" c="dimmed">{model.provider}</Text>
    <TextInput label={t("modelAdmin.wireId")} value={model.wireId} readOnly />
    <TextInput label={t("modelAdmin.name")} value={form.displayName} disabled={busy} required onChange={event => setForm({ ...form, displayName: event.currentTarget.value })} />
    <Select label={t("models.type")} value={form.type} disabled={busy} allowDeselect={false}
      data={REGISTRY_MODEL_TYPES.map(value => ({ value, label: t(`models.type.${value}`) }))}
      onChange={value => { if (value) setForm({ ...form, type: value as RegistryModelType }); }} />
    <SimpleGrid cols={{ base: 1, sm: 2 }}>
      <NumberInput label={t("modelAdmin.context")} value={form.contextWindow} min={0} allowDecimal={false} disabled={busy} onChange={value => setForm({ ...form, contextWindow: Number(value) })} />
      <NumberInput label={t("modelAdmin.output")} value={form.maxTokens} min={0} allowDecimal={false} disabled={busy || form.type === "embedding" || form.type === "rerank"} onChange={value => setForm({ ...form, maxTokens: Number(value) })} />
    </SimpleGrid>
    <Text size="xs" c="dimmed">{t("modelAdmin.unknownLimits")}</Text>
    <SimpleGrid cols={2}>{(["tools", "structuredOutput", "imageInput", "reasoning"] as const).map(key => <Checkbox key={key} label={t(`modelAdmin.${key}`)}
      checked={form.capabilities[key]} disabled={busy} onChange={event => setForm({ ...form, capabilities: { ...form.capabilities, [key]: event.currentTarget.checked } })} />)}</SimpleGrid>
    <Checkbox label={t("modelAdmin.reasoningWithTools")} checked={form.capabilities.reasoningWithTools} disabled={busy}
      onChange={event => setForm({ ...form, capabilities: { ...form.capabilities, reasoningWithTools: event.currentTarget.checked } })} />
    <Checkbox label={t("modelAdmin.priced")} checked={priced} disabled={busy} onChange={event => setPriced(event.currentTarget.checked)} />
    {priced && <SimpleGrid cols={2}>
      <NumberInput label={t("modelAdmin.inputPrice")} description={t("modelAdmin.price")} value={form.pricing.inputPer1M} min={0} disabled={busy} onChange={value => setForm({ ...form, pricing: { ...form.pricing, inputPer1M: Number(value) } })} />
      <NumberInput label={t("modelAdmin.outputPrice")} description={t("modelAdmin.price")} value={form.pricing.outputPer1M} min={0} disabled={busy} onChange={value => setForm({ ...form, pricing: { ...form.pricing, outputPer1M: Number(value) } })} />
    </SimpleGrid>}
    {priced && ([
      ["transcription", "perAudioMinute", "modelAdmin.perMinute"],
      ["image", "perImage", "modelAdmin.perImage"],
      ["rerank", "perSearch", "modelAdmin.perSearch"],
    ] as const).filter(([type]) => type === form.type).map(([, key, label]) => <NumberInput key={key}
      label={t(label)} value={form.pricing[key] ?? ""} min={0} disabled={busy}
      onChange={value => setForm({ ...form, pricing: { ...form.pricing, [key]: value === "" ? undefined : Number(value) } })} />)}
  </FormModal>;
}
