"use client";

import { LoadingText } from "@/app/_components/PageState";
import { SectionHeading } from "@/app/_components/SectionHeading";
import { useCallback, useEffect, useState } from "react";
import { Alert, Stack } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { ModelSelect } from "@/app/_components/modelOptions";
import { readJson, jsonHeaders } from "@/app/_lib/httpClient";
import { ModelSelectionSection } from "@/app/models/ModelSelectionSection";
import { WorkspaceModelsSection } from "@/app/models/WorkspaceModelsSection";
import type { ModelsCatalogResponse } from "@/app/api/models/catalog/route";
import type { DefaultModelResponse } from "@/app/api/models/default/route";
import type { DecisionModelResponse } from "@/app/api/models/decision/route";

interface UsageView { catalog: ModelsCatalogResponse; selected: DefaultModelResponse }
export default function ModelUsagePage() {
  const t = useT();
  const [view, setView] = useState<UsageView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState(false);
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
  async function selectDecision(model: string | null) {
    if (decisionBusy) return;
    setDecisionBusy(true); setError(undefined);
    try {
      const selected = await readJson<DecisionModelResponse>(await fetch("/api/models/decision", {
        method: "PUT", headers: jsonHeaders, body: JSON.stringify({ model }),
      }));
      setView(current => current ? {
        ...current,
        catalog: {
          ...current.catalog,
          selections: { ...current.catalog.selections, decision: selected.model ? { model: selected.model, source: "override" } : undefined },
        },
      } : current);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not save decision model"); }
    finally { setDecisionBusy(false); }
  }
  const defaultOptions = view?.catalog.models.filter(model =>
    model.type === "text" && model.capabilities.tools && !model.selectionHidden,
  ) ?? [];
  const decisionOptions = view?.catalog.models.filter(model =>
    model.type === "decisions" && (model.providerKind === "openrouter" || model.providerKind === "selfhosted") && !model.selectionHidden,
  ) ?? [];
  return <Stack gap="lg">
    <SectionHeading title={t("modelAdmin.usage")} description={t("modelAdmin.usageHint")} />
    {error && <Alert color="red">{error}</Alert>}
    {!view && !error && <LoadingText />}
    {view && <>
      <ModelSelect label={t("modelAdmin.default")} placeholder={t("models.selection.unconfigured")} searchable disabled={busy} allowDeselect={false}
        value={view.selected.model} models={defaultOptions}
        leading={view.selected.model && !defaultOptions.some(model => model.id === view.selected.model)
          ? [{ value: view.selected.model, label: view.selected.model }] : []}
        onChange={model => void select(model)} />
      <ModelSelect label={t("modelAdmin.decision")} placeholder={t("models.selection.unconfigured")} searchable clearable disabled={decisionBusy}
        clearButtonProps={{ "aria-label": t("modelAdmin.clearDecision"), "aria-hidden": false, tabIndex: 0 }}
        value={view.catalog.selections.decision?.model ?? null} models={decisionOptions}
        leading={view.catalog.selections.decision?.model && !decisionOptions.some(model => model.id === view.catalog.selections.decision?.model)
          ? [{ value: view.catalog.selections.decision.model, label: view.catalog.selections.decision.model }] : []}
        onChange={model => void selectDecision(model)} />
      <WorkspaceModelsSection />
      <ModelSelectionSection models={view.catalog.models} selections={view.catalog.selections} rerankerMinScore={view.catalog.rerankerMinScore}
        available={view.catalog.selectionAvailable} onChanged={async () => setView(await load())} />
    </>}
  </Stack>;
}
