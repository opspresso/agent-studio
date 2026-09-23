"use client";

import { useEffect, useState } from "react";
import { Alert, Loader, Stack, Text } from "@mantine/core";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { ModelSelect } from "@/app/_components/modelOptions";
import { useT } from "@/app/_i18n/provider";
import { jsonHeaders, readJson } from "@/app/_lib/httpClient";
import { WORKSPACE_MODEL_RUNTIMES, type WorkspaceModelRuntime } from "@/domain/workspace/runtimeModels";
import type { WorkspaceRuntimeModelsResponse } from "@/app/api/models/workspace/route";

export function WorkspaceModelsSection() {
  const t = useT();
  const [view, setView] = useState<WorkspaceRuntimeModelsResponse>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    void fetch("/api/models/workspace").then(response => readJson<WorkspaceRuntimeModelsResponse>(response))
      .then(next => { if (current) setView(next); }).catch(error => { if (current) setError(error instanceof Error ? error.message : "Workspace models could not be loaded"); });
    return () => { current = false; };
  }, []);
  async function select(runtime: WorkspaceModelRuntime, model: string | null) {
    if (busy) return;
    setBusy(true); setError(undefined);
    try { setView(await readJson<WorkspaceRuntimeModelsResponse>(await fetch("/api/models/workspace", { method: "PUT", headers: jsonHeaders, body: JSON.stringify({ runtime, model }) }))); }
    catch (error) { setError(error instanceof Error ? error.message : "Workspace model could not be saved"); }
    finally { setBusy(false); }
  }
  return <CollapsibleSection title={t("workspace.modelsTitle")}>
    <Stack gap="md">
      <Text size="sm" c="dimmed">{t("workspace.modelsHint")}</Text>
      {error && <Alert color="red">{error}</Alert>}
      {!view && !error && <Loader size="sm" />}
      {view && WORKSPACE_MODEL_RUNTIMES.map(runtime => {
        const selected = view.selections[runtime];
        const options = view.options[runtime];
        return <ModelSelect key={runtime} label={runtime === "codex" ? "Codex" : runtime === "claude" ? "Claude" : "OpenCode"}
          value={selected ?? null} placeholder={t("workspace.modelDisabled")} searchable clearable disabled={busy}
          models={options}
          leading={selected && !options.some(option => option.id === selected) ? [{ value: selected, label: selected }] : []}
          error={selected && !view.available.includes(runtime) ? t("workspace.modelUnavailable") : undefined}
          onChange={model => { void select(runtime, model); }} />;
      })}
    </Stack>
  </CollapsibleSection>;
}
