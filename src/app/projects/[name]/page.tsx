"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  createVersion,
  getProject,
  listModels,
  listVersions,
  publishVersion,
  updateVersion,
  type ModelConfig,
  type SanitizedProject,
  type Version,
  type VersionInput,
} from "../lib/api";
import { useT } from "@/app/_i18n/provider";
import { useConfirm } from "@/app/_components/useConfirm";
import { VersionEditor } from "./_components/VersionEditor";
import { RunPanel } from "./_components/RunPanel";
import { PromptPreview } from "./_components/PromptPreview";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { LoadingText } from "@/app/_components/PageState";
import { canEditProject, useViewer } from "@/app/_lib/useViewer";
import { tierAtLeast } from "@/domain/member/tiers";
import { Alert, Button, Grid, Group, Select, Stack, Text } from "@mantine/core";
import classes from "./Playground.module.css";

/**
 * Whether the run's model can take the images the panel would attach — vision for
 * a text run, the edit endpoint for an image project. `undefined` when the model
 * is not in the fetched catalog, so an unlisted-but-valid model is not blocked.
 */
function runImageCapability(
  models: ModelConfig[],
  modelId: string,
  projectType: SanitizedProject["projectType"],
): boolean | undefined {
  const model = models.find((m) => m.id === modelId);
  if (!model) {
    return undefined;
  }
  return projectType === "image"
    ? Boolean(model.capabilities.imageGeneration)
    : model.capabilities.imageInput;
}

/** How long "Saved" stays up. Longer than the copy buttons' flash, because it
 *  confirms a write rather than a clipboard, and short enough to stay current. */
const SAVED_NOTICE_MS = 3000;

function toInput(version: Version): VersionInput {
  return {
    systemPrompt: version.systemPrompt,
    userPromptTemplate: version.userPromptTemplate,
    model: version.model,
    fallbackModel: version.fallbackModel,
    parameters: version.parameters,
    mcpList: version.mcpList,
    skillList: version.skillList,
    subagentList: version.subagentList,
    maxTurn: version.maxTurn,
  };
}

function emptyInput(models: ModelConfig[]): VersionInput {
  return {
    systemPrompt: "",
    userPromptTemplate: "",
    model: models[0]?.id ?? "",
    parameters: { piiFiltering: false },
    mcpList: [],
    skillList: [],
    subagentList: [],
  };
}

export default function PlaygroundPage() {
  const params = useParams<{ name: string }>();
  const name = params.name;

  const viewer = useViewer();
  const t = useT();
  const [project, setProject] = useState<SanitizedProject | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [selectedName, setSelectedName] = useState<string>("");
  const [draft, setDraft] = useState<VersionInput>(emptyInput([]));
  const [snapshot, setSnapshot] = useState<string>("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /**
   * Which version the last save wrote. A save is fast enough that "Saving…" is
   * gone before it registers, so the confirmation outlives it — but only for a
   * moment, the way the copy buttons do it. It reads as stale the longer it
   * sits, since the thing it confirms is already several actions back.
   */
  const [savedName, setSavedName] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { confirm, confirmModal } = useConfirm();

  useEffect(() => {
    return () => {
      if (savedTimer.current) {
        clearTimeout(savedTimer.current);
      }
    };
  }, []);

  function clearSaved() {
    if (savedTimer.current) {
      clearTimeout(savedTimer.current);
      savedTimer.current = null;
    }
    setSavedName(null);
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [proj, vers, mods] = await Promise.all([
          getProject(name),
          listVersions(name),
          listModels(),
        ]);
        if (cancelled) {
          return;
        }
        setProject(proj);
        setVersions(vers);
        setModels(mods);

        const initial =
          vers.find((v) => v.versionName === proj.publishedVersion) ??
          [...vers].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
        if (initial) {
          setSelectedName(initial.versionName);
          const input = toInput(initial);
          setDraft(input);
          setSnapshot(JSON.stringify(input));
        } else {
          const input = emptyInput(mods);
          setSelectedName("");
          setDraft(input);
          setSnapshot("");
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : t("playground.loadFailed"));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [name]);

  const dirty = useMemo(() => JSON.stringify(draft) !== snapshot, [draft, snapshot]);

  function selectVersion(versionName: string) {
    if (versionName === "") {
      // New versions start as a copy of whatever is currently in the editor.
      setSelectedName("");
      setSnapshot("");
      return;
    }
    const version = versions.find((v) => v.versionName === versionName);
    if (version) {
      const input = toInput(version);
      setSelectedName(versionName);
      setDraft(input);
      setSnapshot(JSON.stringify(input));
      clearSaved();
    }
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    clearSaved();
    let savedVersion: string | null = null;
    try {
      const saved =
        selectedName === ""
          ? await createVersion(name, draft)
          : await updateVersion(name, selectedName, {
              ...draft,
              fallbackModel: draft.fallbackModel ?? null,
              maxTurn: draft.maxTurn ?? null,
            });
      const refreshed = await listVersions(name);
      setVersions(refreshed);
      setSelectedName(saved.versionName);
      const input = toInput(saved);
      setDraft(input);
      setSnapshot(JSON.stringify(input));
      setSavedName(saved.versionName);
      savedTimer.current = setTimeout(() => setSavedName(null), SAVED_NOTICE_MS);
      savedVersion = saved.versionName;
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : t("playground.saveFailed"));
    } finally {
      setSaving(false);
    }
    // A save on a never-published project is the natural moment to ask whether
    // it is ready for callers. Publish is what turns the external surfaces on
    // (API, A2A, triggers, Slack, the subagent picker), so it stays a question
    // rather than a side effect; once anything is published, saves stop asking.
    if (savedVersion && project && !project.publishedVersion) {
      const publish = await confirm({
        title: t("playground.publishTitle"),
        message: t("playground.publishBody", {
          project: project.displayName || name,
          version: savedVersion,
        }),
        confirmLabel: t("playground.publishConfirm", { version: savedVersion }),
        color: "teal",
      });
      if (publish) {
        try {
          setProject(await publishVersion(name, savedVersion));
        } catch (e) {
          setSaveError(e instanceof Error ? e.message : t("playground.publishFailed"));
        }
      }
    }
  }

  // `viewer === null` is still loading, like the settings page: rendering
  // before it resolves would flash the owner a read-only editor.
  if (loading || viewer === null) {
    return <LoadingText />;
  }
  if (error || !project) {
    return (
      <Alert color="red" variant="light">
        {error ?? t("playground.notFound")}
      </Alert>
    );
  }

  const canEdit = canEditProject(viewer, project.ownerEmail);
  // The same rung `POST /preview` answers on, for the same reason: the panel
  // renders the prompt, the skill table and the tool names — the capability
  // registry a guest is refused, assembled for one project.
  const canPreview = tierAtLeast(viewer.tier, "member");

  return (
    <Grid gap="lg">
      {confirmModal}
      <Grid.Col span={{ base: 12, lg: 6 }}>
        <Stack gap="md">
          <Group justify="space-between" gap="xs" wrap="nowrap">
            <Select
              value={selectedName}
              onChange={(value) => selectVersion(value ?? "")}
              allowDeselect={false}
              data={[
                ...(canEdit ? [{ value: "", label: t("playground.newVersion") }] : []),
                ...versions.map((version) => ({
                  value: version.versionName,
                  label:
                    project.publishedVersion === version.versionName
                      ? t("playground.versionPublished", { version: version.versionName })
                      : t("playground.version", { version: version.versionName }),
                })),
              ]}
            />
            {canEdit ? (
              <Group gap="xs" wrap="nowrap">
                {dirty ? (
                  <Text fz="xs" c="orange">
                    {t("playground.unsaved")}
                  </Text>
                ) : (
                  savedName && (
                    <Text fz="xs" c="teal">
                      {t("playground.saved", { version: savedName })}
                    </Text>
                  )
                )}
                <Button onClick={save} loading={saving} disabled={!draft.model}>
                  {selectedName === "" ? t("playground.createVersion") : t("playground.save")}
                </Button>
              </Group>
            ) : (
              <Text fz="xs" c="dimmed">
                {t("playground.readOnly")}
              </Text>
            )}
          </Group>

          {saveError && (
            <Alert color="red" variant="light">
              {saveError}
            </Alert>
          )}

          {/*
           * The save above is gated for a non-editor, and this inerts the form
           * itself: a disabled fieldset disables every nested native control,
           * and everything interactive in the editor is one — inputs, selects,
           * checkboxes, the binding dialogs' and chips' buttons. Run and
           * Preview live outside it on purpose; both are session surfaces.
           */}
          <fieldset
            disabled={!canEdit}
            className={canEdit ? undefined : classes.readonlyEditor}
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
          >
            <VersionEditor
              projectName={project.name}
              projectType={project.projectType}
              models={models.filter((m) =>
                project.projectType === "image"
                  ? m.capabilities.imageGeneration
                  : !m.capabilities.imageGeneration,
              )}
              imageModels={models.filter((m) => m.capabilities.imageGeneration)}
              value={draft}
              onChange={setDraft}
              save={{
                run: save,
                saving,
                disabled: !draft.model,
                error: saveError,
                savedName: dirty ? null : savedName,
                label: selectedName === "" ? t("playground.createVersion") : t("playground.save"),
              }}
            />
          </fieldset>
        </Stack>
      </Grid.Col>

      <Grid.Col span={{ base: 12, lg: 6 }}>
        <Stack gap="md">
          {canPreview && (
            <CollapsibleSection title={t("playground.preview")}>
              <PromptPreview
                projectName={name}
                projectType={project.projectType}
                draft={draft}
                versionName={selectedName || null}
              />
            </CollapsibleSection>
          )}

          {/*
            Open on arrival: running the version is what the Playground is for,
            and it is the only panel on this page a guest is offered at all.
          */}
          <CollapsibleSection title={t("playground.run")} defaultOpen>
            <RunPanel
              key={`${name}/${selectedName || "unsaved"}`}
              projectName={name}
              versionName={dirty && selectedName === "" ? null : selectedName || null}
              projectType={project.projectType}
              userPromptTemplate={draft.userPromptTemplate}
              modelAcceptsImages={runImageCapability(models, draft.model, project.projectType)}
            />
          </CollapsibleSection>
        </Stack>
      </Grid.Col>
    </Grid>
  );
}
