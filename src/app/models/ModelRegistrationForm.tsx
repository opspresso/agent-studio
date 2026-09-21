"use client";

import { useState } from "react";
import { Alert, Button, Checkbox, Group, NumberInput, Select, SimpleGrid, Stack, Text, TextInput } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { jsonHeaders, readJson } from "@/app/_lib/httpClient";
import { REGISTRY_MODEL_TYPES, registeredModelId, type DiscoveredModel, type RegisteredModel, type RegistryModelType } from "@/domain/llm/providerModels";
import type { ModelRegistryResponse } from "@/app/api/models/registry/route";

export function ModelRegistrationForm({ provider, candidate, onSaved, onCancel }: {
  provider: string;
  candidate?: DiscoveredModel;
  onSaved(models: RegisteredModel[]): void;
  onCancel(): void;
}) {
  const t = useT();
  const [form, setForm] = useState({
    wireId: candidate?.wireId ?? "", displayName: candidate?.displayName ?? "",
    type: candidate?.type ?? "text" as RegistryModelType,
    contextWindow: candidate?.contextWindow ?? 0, maxTokens: candidate?.maxTokens ?? 0,
    capabilities: { tools: false, structuredOutput: false, imageInput: false, reasoning: false, ...candidate?.capabilities },
    pricing: candidate?.pricing ?? { inputPer1M: 0, outputPer1M: 0 },
  });
  const [priced, setPriced] = useState(candidate?.pricing !== undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function save() {
    if (busy) return;
    setBusy(true); setError(undefined);
    try {
      const { pricing, ...fields } = form;
      const model: RegisteredModel = {
        ...fields, provider, id: registeredModelId(provider, form.wireId.trim()),
        wireId: form.wireId.trim(), displayName: form.displayName.trim(),
        maxTokens: form.type === "embedding" || form.type === "rerank" ? 0 : form.maxTokens,
        ...(priced ? { pricing } : {}),
      };
      const saved = await readJson<ModelRegistryResponse>(await fetch("/api/models/registry", { method: "POST", headers: jsonHeaders, body: JSON.stringify(model) }));
      onSaved(saved.models);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not register model"); }
    finally { setBusy(false); }
  }
  return <Stack>
    {error && <Alert color="red">{error}</Alert>}
    <Text size="sm" c="dimmed">{provider}</Text>
    <TextInput label={t("modelAdmin.wireId")} value={form.wireId} disabled={busy || !!candidate} required onChange={event => setForm({ ...form, wireId: event.currentTarget.value })} />
    <TextInput label={t("modelAdmin.name")} value={form.displayName} disabled={busy} required onChange={event => setForm({ ...form, displayName: event.currentTarget.value })} />
    <Select label={t("models.type")} value={form.type} disabled={busy} allowDeselect={false}
      data={REGISTRY_MODEL_TYPES.map(value => ({ value, label: t(`models.type.${value}`) }))}
      onChange={value => { if (value) setForm({ ...form, type: value as RegistryModelType }); }} />
    <SimpleGrid cols={{ base: 1, sm: 2 }}>
      <NumberInput label={t("modelAdmin.context")} value={form.contextWindow} min={0} allowDecimal={false} disabled={busy} onChange={value => setForm({ ...form, contextWindow: Number(value) })} />
      <NumberInput label={t("modelAdmin.output")} value={form.maxTokens} min={0} allowDecimal={false} disabled={busy || form.type === "embedding" || form.type === "rerank"} onChange={value => setForm({ ...form, maxTokens: Number(value) })} />
    </SimpleGrid>
    <Text size="xs" c="dimmed">{t("modelAdmin.unknownLimits")}</Text>
    <SimpleGrid cols={2}>{(["tools", "structuredOutput", "imageInput", "reasoning"] as const).map(key => <Checkbox key={key} label={key}
      checked={form.capabilities[key]} disabled={busy} onChange={event => setForm({ ...form, capabilities: { ...form.capabilities, [key]: event.currentTarget.checked } })} />)}</SimpleGrid>
    <Checkbox label={t("modelAdmin.priced")} checked={priced} disabled={busy} onChange={event => setPriced(event.currentTarget.checked)} />
    {priced && <SimpleGrid cols={2}>
      <NumberInput label={t("modelAdmin.inputPrice")} description={t("modelAdmin.price")} value={form.pricing.inputPer1M} min={0} disabled={busy} onChange={value => setForm({ ...form, pricing: { ...form.pricing, inputPer1M: Number(value) } })} />
      <NumberInput label={t("modelAdmin.outputPrice")} description={t("modelAdmin.price")} value={form.pricing.outputPer1M} min={0} disabled={busy} onChange={value => setForm({ ...form, pricing: { ...form.pricing, outputPer1M: Number(value) } })} />
    </SimpleGrid>}
    <Group justify="flex-end"><Button variant="default" disabled={busy} onClick={onCancel}>{t("common.cancel")}</Button>
      <Button loading={busy} disabled={!form.wireId.trim() || !form.displayName.trim()} onClick={() => void save()}>{t("modelAdmin.save")}</Button></Group>
  </Stack>;
}
