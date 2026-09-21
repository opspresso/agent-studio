"use client";

import { LoadingText } from "@/app/_components/PageState";
import { SectionHeading } from "@/app/_components/SectionHeading";
import { useCallback, useEffect, useState } from "react";
import { Alert, Select, Stack } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { readJson, jsonHeaders } from "@/app/_lib/httpClient";
import { ModelSelectionSection } from "@/app/models/ModelSelectionSection";
import { WorkspaceModelsSection } from "@/app/models/WorkspaceModelsSection";
import type { ModelsCatalogResponse } from "@/app/api/models/catalog/route";
import type { DefaultModelResponse } from "@/app/api/models/default/route";

interface UsageView { catalog: ModelsCatalogResponse; selected: DefaultModelResponse }
export default function ModelUsagePage() {
  const t = useT();
  const [view, setView] = useState<UsageView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [catalog, selected] = await Promise.all([
      fetch("/api/models/catalog").then(response => readJson<ModelsCatalogResponse>(response)),
      fetch("/api/models/default").then(response => readJson<DefaultModelResponse>(response)),
    ]);
    return { catalog, selected };
  }, []);
  useEffect(() => {
    let current = true;
    void load().then(value => { if (current) setView(value); })
      .catch(error => { if (current) setError(error instanceof Error ? error.message : "Could not load model usage"); });
    return () => { current = false; };
  }, [load]);
  async function select(model: string | null) {
    if (!model || busy) return;
    setBusy(true); setError(undefined);
    try {
      const selected = await readJson<DefaultModelResponse>(await fetch("/api/models/default", { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ model }) }));
      setView(current => current ? { ...current, selected } : current);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save default model"); }
    finally { setBusy(false); }
  }
  return <Stack gap="lg">
    <SectionHeading title={t("modelAdmin.usage")} description={t("modelAdmin.usageHint")} />
    {error && <Alert color="red">{error}</Alert>}
    {!view && !error && <LoadingText />}
    {view && <>
      <Select label={t("modelAdmin.default")} placeholder={t("models.selection.unconfigured")} searchable disabled={busy} allowDeselect={false}
        value={view.selected.model} data={view.catalog.models.filter(model => ["text", "decisions"].includes(model.type) && model.capabilities.tools).map(model => ({ value: model.id, label: `${model.displayName} (${model.provider})` }))} onChange={model => void select(model)} />
      <WorkspaceModelsSection />
      <ModelSelectionSection models={view.catalog.models} selections={view.catalog.selections} rerankerMinScore={view.catalog.rerankerMinScore}
        available={view.catalog.selectionAvailable} onChanged={async () => setView(await load())} />
    </>}
  </Stack>;
}
