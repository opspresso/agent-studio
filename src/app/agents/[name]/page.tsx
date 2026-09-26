"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Alert, Button, Grid, Group, Stack, Text } from "@mantine/core";
import { getConfiguration, getAgent, listModels, putConfiguration,
  type AgentConfiguration, type AgentConfigurationInput, type SelectableModel, type SanitizedAgent } from "../lib/api";
import { useT } from "@/app/_i18n/provider";
import { canEditAgent, useViewer } from "@/app/_lib/useViewer";
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
  const { agentName: _agent, ...settings } = configuration;
  return settings;
}
function emptyInput(models: SelectableModel[] = []): AgentConfigurationInput {
  return { systemPrompt: "", model: models.find(model => modelType(model) === "text" && model.capabilities.tools)?.id ?? "",
    parameters: { piiFiltering: false }, mcpList: [], skillList: [], subagentList: [] };
}

export default function PlaygroundPage() {
  const { name } = useParams<{ name: string }>();
  const t = useT();
  const viewer = useViewer();
  const [agent, setAgent] = useState<SanitizedAgent | null>(null);
  const [models, setModels] = useState<SelectableModel[]>([]);
  const [configuration, setConfiguration] = useState<AgentConfiguration | null>(null);
  const [updatedAt, setUpdatedAt] = useState("");
  const [draft, setDraft] = useState<AgentConfigurationInput>(emptyInput());
  const [snapshot, setSnapshot] = useState("");
  const [schemaText, setSchemaText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const latestOnly = useRef(createLatestOnly()).current;

  useEffect(() => {
    const isCurrent = latestOnly();
    setSaving(false);
    setLoading(true);
    setError(null);
    setModelError(null);
    setSaved(false);
    setSaveError(null);
    const modelRead = listModels()
      .then((models) => ({ models, error: null }))
      .catch((error) => ({
        models: [] as SelectableModel[],
        error: error instanceof Error ? error.message : "Model registry unavailable",
      }));
    void Promise.all([getAgent(name), getConfiguration(name), modelRead]).then(([agent, view, modelList]) => {
      if (!isCurrent()) return;
      const next = view.configuration ? editable(view.configuration) : emptyInput(modelList.models);
      setAgent(agent);
      setModels(modelList.models);
      setModelError(modelList.error);
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
  if (error || !agent || agent.name !== name) return <Alert color="red">{error ?? t("playground.notFound")}</Alert>;
  const canEdit = canEditAgent(viewer, agent.ownerEmail);
  const canPreview = tierAtLeast(viewer.tier, "member");
  const runModel = models.find(model => model.id === configuration?.model);
  const saveState = { run: save, saving, disabled: !draft.model || schemaError !== null,
    error: schemaError ?? saveError, saved: saved && !dirty, label: t("playground.save") };

  const configurationColumn = (
    <Grid.Col key="configuration" span={{ base: 12, lg: 5 }}>
      <Stack gap="md">
        <Group justify="space-between" className={classes.columnHeading}>
          <Text fw={600}>{t("configuration.title")}</Text>
          {canEdit ? <Group gap="xs">
            {dirty ? <Text fz="xs" c="orange">{t("playground.unsaved")}</Text>
              : saved ? <Text fz="xs" c="teal">{t("configuration.saved")}</Text> : null}
            <Button onClick={save} loading={saving}
              disabled={saveState.disabled || (configuration !== null && !dirty)}>{t("playground.save")}</Button>
          </Group> : <Text fz="xs" c="dimmed">{t("playground.readOnly")}</Text>}
        </Group>
        {modelError && <Alert color="yellow">{t("playground.modelRegistryWarning", { error: modelError })}</Alert>}
        {saveError && <Alert color="red">{saveError}</Alert>}
        <CollapsibleSection title={t("playground.editSettings")} defaultOpen={configuration === null}>
          <fieldset disabled={!canEdit || saving} className={canEdit ? undefined : classes.readonlyEditor}
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <AgentConfigurationEditor key={name} agentName={name}
              models={models.filter(model => modelType(model) === "text")}
              imageModels={models.filter(model => modelType(model) === "image")}
              value={draft} onChange={setDraft} schemaText={currentSchema} onSchemaChange={setSchemaText}
              schemaError={schemaError} save={saveState} />
          </fieldset>
        </CollapsibleSection>
        {canPreview && <CollapsibleSection title={t("playground.preview")}>
          <PromptPreview agentName={name} draft={parsed ?? draft} validationError={schemaError} />
        </CollapsibleSection>}
      </Stack>
    </Grid.Col>
  );
  const runColumn = (
    <Grid.Col key="run" span={{ base: 12, lg: 7 }}>
      <section className={classes.runSurface} aria-labelledby="playground-run-title">
        <Text component="h2" id="playground-run-title" fw={650} fz="lg">{t("playground.run")}</Text>
        <Text fz="sm" c="dimmed" mt={4} mb="lg">{t("playground.runHint")}</Text>
        <RunPanel key={name} agentName={name} configured={configuration !== null}
          modelAcceptsImages={runModel?.capabilities.imageInput} />
      </section>
    </Grid.Col>
  );

  return <Grid gap="xl">{configuration === null ? configurationColumn : runColumn}
    {configuration === null ? runColumn : configurationColumn}</Grid>;
}
