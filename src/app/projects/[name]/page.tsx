"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Alert, Button, Grid, Group, Stack, Text } from "@mantine/core";
import { getConfiguration, getProject, listModels, putConfiguration,
  type AgentConfiguration, type AgentConfigurationInput, type SelectableModel, type SanitizedProject } from "../lib/api";
import { useT } from "@/app/_i18n/provider";
import { canEditProject, useViewer } from "@/app/_lib/useViewer";
import { tierAtLeast } from "@/domain/member/tiers";
import { modelType } from "@/domain/llm/models";
import { LoadingText } from "@/app/_components/PageState";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { AgentConfigurationEditor, parseConfigurationDraft } from "./_components/AgentConfigurationEditor";
import { PromptPreview } from "./_components/PromptPreview";
import { RunPanel } from "./_components/RunPanel";
import { createLatestOnly } from "@/app/_lib/latestOnly";
import classes from "./Playground.module.css";

function editable(configuration: AgentConfiguration): AgentConfigurationInput {
  const { projectName: _project, ...settings } = configuration;
  return settings;
}
function emptyInput(models: SelectableModel[] = []): AgentConfigurationInput {
  return { systemPrompt: "", model: models.find(model => ["text", "decisions"].includes(modelType(model)) && model.capabilities.tools)?.id ?? "",
    parameters: { piiFiltering: false }, mcpList: [], skillList: [], subagentList: [] };
}

export default function PlaygroundPage() {
  const { name } = useParams<{ name: string }>();
  const t = useT();
  const viewer = useViewer();
  const [project, setProject] = useState<SanitizedProject | null>(null);
  const [models, setModels] = useState<SelectableModel[]>([]);
  const [configuration, setConfiguration] = useState<AgentConfiguration | null>(null);
  const [updatedAt, setUpdatedAt] = useState("");
  const [draft, setDraft] = useState<AgentConfigurationInput>(emptyInput());
  const [snapshot, setSnapshot] = useState("");
  const [schemaText, setSchemaText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const latestOnly = useRef(createLatestOnly()).current;

  useEffect(() => {
    const isCurrent = latestOnly();
    setSaving(false);
    setLoading(true);
    setError(null);
    setSaved(false);
    setSaveError(null);
    void Promise.all([getProject(name), getConfiguration(name), listModels()]).then(([project, view, models]) => {
      if (!isCurrent()) return;
      const next = view.configuration ? editable(view.configuration) : emptyInput(models);
      setProject(project);
      setModels(models);
      setConfiguration(view.configuration);
      setUpdatedAt(view.updatedAt);
      setDraft(next);
      setSnapshot(JSON.stringify(next));
      setSchemaText(null);
    }).catch(error => {
      if (isCurrent()) setError(error instanceof Error ? error.message : t("playground.loadFailed"));
    }).finally(() => { if (isCurrent()) setLoading(false); });
    return () => { latestOnly(); };
  }, [name, latestOnly]);

  const currentSchema = schemaText ?? (draft.parameters.jsonSchema ? JSON.stringify(draft.parameters.jsonSchema, null, 2) : "");
  const parsed = useMemo(() => parseConfigurationDraft(draft, currentSchema), [draft, currentSchema]);
  const schemaError = parsed === null ? t("configuration.invalidJson") : null;
  const dirty = parsed === null || JSON.stringify(parsed) !== snapshot;

  async function save() {
    if (!parsed || saving) return;
    const isCurrent = latestOnly();
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const result = await putConfiguration(name, { ...parsed, expectedUpdatedAt: updatedAt });
      if (!isCurrent()) return;
      const next = editable(result.configuration!);
      setConfiguration(result.configuration);
      setUpdatedAt(result.updatedAt);
      setDraft(next);
      setSnapshot(JSON.stringify(next));
      setSchemaText(null);
      setSaved(true);
    } catch (error) {
      if (isCurrent()) setSaveError(error instanceof Error ? error.message : t("playground.saveFailed"));
    } finally { if (isCurrent()) setSaving(false); }
  }

  if (loading || viewer === null) return <LoadingText />;
  if (error || !project || project.name !== name) return <Alert color="red">{error ?? t("playground.notFound")}</Alert>;
  const canEdit = canEditProject(viewer, project.ownerEmail);
  const canPreview = tierAtLeast(viewer.tier, "member");
  const runModel = models.find(model => model.id === configuration?.model);
  const saveState = { run: save, saving, disabled: !draft.model || schemaError !== null,
    error: schemaError ?? saveError, saved: saved && !dirty, label: t("playground.save") };

  return (
    <Grid gap="lg">
      <Grid.Col span={{ base: 12, lg: 6 }}>
        <Stack gap="md">
          <Group justify="space-between">
            <Text fw={600}>{t("configuration.title")}</Text>
            {canEdit ? <Group gap="xs">
              {dirty ? <Text fz="xs" c="orange">{t("playground.unsaved")}</Text>
                : saved ? <Text fz="xs" c="teal">{t("configuration.saved")}</Text> : null}
              <Button onClick={save} loading={saving} disabled={saveState.disabled}>{t("playground.save")}</Button>
            </Group> : <Text fz="xs" c="dimmed">{t("playground.readOnly")}</Text>}
          </Group>
          {saveError && <Alert color="red">{saveError}</Alert>}
          <fieldset disabled={!canEdit || saving} className={canEdit ? undefined : classes.readonlyEditor}
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <AgentConfigurationEditor key={name} projectName={name}
              models={models.filter(model => ["text", "decisions"].includes(modelType(model)))}
              imageModels={models.filter(model => modelType(model) === "image")}
              value={draft} onChange={setDraft} schemaText={currentSchema} onSchemaChange={setSchemaText}
              schemaError={schemaError} save={saveState} />
          </fieldset>
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, lg: 6 }}>
        <Stack gap="md">
          {canPreview && <CollapsibleSection title={t("playground.preview")}>
            <PromptPreview projectName={name} draft={parsed ?? draft} validationError={schemaError} />
          </CollapsibleSection>}
          <CollapsibleSection title={t("playground.run")} defaultOpen>
            <RunPanel key={name} projectName={name} configured={configuration !== null}
              modelAcceptsImages={runModel?.capabilities.imageInput} />
          </CollapsibleSection>
        </Stack>
      </Grid.Col>
    </Grid>
  );
}
