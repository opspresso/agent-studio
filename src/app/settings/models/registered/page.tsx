"use client";

import { LoadingText } from "@/app/_components/PageState";
import { SectionHeading } from "@/app/_components/SectionHeading";
import { ModelCollection } from "@/app/models/ModelCollection";
import { useEffect, useState } from "react";
import { Alert, Button, Stack, Text } from "@mantine/core";
import { useConfirm } from "@/app/_components/useConfirm";
import { useT } from "@/app/_i18n/provider";
import { checkRegisteredModel, deleteRegisteredModel, listRegisteredModels } from "@/app/models/api";
import { useViewer } from "@/app/_lib/useViewer";
import { ModelEditor } from "@/app/models/ModelEditor";
import { type RegisteredModel } from "@/domain/llm/providerModels";

export default function RegisteredModelsPage() {
  const t = useT();
  const viewer = useViewer();
  const [models, setModels] = useState<RegisteredModel[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<RegisteredModel>();
  const { confirm, confirmModal } = useConfirm();
  useEffect(() => {
    let current = true;
    void listRegisteredModels().then(value => { if (current) setModels(value); }).catch(error => { if (current) setError(error instanceof Error ? error.message : "Could not load models"); });
    return () => { current = false; };
  }, []);
  async function remove(model: RegisteredModel) {
    if (busy || !await confirm({ title: t("modelAdmin.deleteModel"), message: t("modelAdmin.deleteModelHint"), confirmLabel: t("modelAdmin.delete") })) return;
    setBusy(model.id); setError(undefined);
    try { await deleteRegisteredModel(model.id); setModels(current => current?.filter(item => item.id !== model.id)); }
    catch (error) { setError(error instanceof Error ? error.message : "Could not delete model"); }
    finally { setBusy(undefined); }
  }
  async function check(model: RegisteredModel) {
    if (busy) return;
    setBusy(model.id); setError(undefined);
    try {
      const result = await checkRegisteredModel(model.id);
      setStatuses(previous => ({ ...previous, [model.id]: result.available ? t("modelAdmin.available") : t("modelAdmin.missing") }));
    } catch (error) { setStatuses(previous => ({ ...previous, [model.id]: error instanceof Error ? error.message : "Status check failed" })); }
    finally { setBusy(undefined); }
  }
  const canEdit = viewer?.isAdmin === true;
  return <Stack gap="lg">
    <SectionHeading title={t("settings.models.registered")} description={t("settings.models.registeredHint")} />
    {confirmModal}
    {error && <Alert color="red">{error}</Alert>}
    {!models && !error && <LoadingText />}
    {models && <ModelCollection scope="registered" models={models} emptyText={t("modelAdmin.emptyModels")} renderActions={canEdit ? model => <>
      {statuses[model.id] && <Text size="xs" role="status" w="100%">{statuses[model.id]}</Text>}
      <Button variant="default" disabled={!!busy} loading={busy === model.id} onClick={() => void check(model)}>{t("modelAdmin.check")}</Button>
      <Button variant="default" disabled={!!busy} onClick={() => setEditing(model)}>{t("modelAdmin.edit")}</Button>
      <Button variant="subtle" color="red" disabled={!!busy} onClick={() => void remove(model)}>{t("modelAdmin.delete")}</Button>
    </> : undefined} />}
      {editing && <ModelEditor key={editing.id} model={editing} onSaved={models => { setModels(models); setEditing(undefined); }} onCancel={() => setEditing(undefined)} />}
  </Stack>;
}
