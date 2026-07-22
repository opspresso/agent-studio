"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  createVersion,
  getProject,
  listModels,
  listVersions,
  updateVersion,
  type ModelConfig,
  type Project,
  type Version,
  type VersionInput,
} from "../lib/api";
import { VersionEditor } from "./_components/VersionEditor";
import { RunPanel } from "./_components/RunPanel";

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

  const [project, setProject] = useState<Project | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [selectedName, setSelectedName] = useState<string>("");
  const [draft, setDraft] = useState<VersionInput>(emptyInput([]));
  const [snapshot, setSnapshot] = useState<string>("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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
          setError(e instanceof Error ? e.message : "Failed to load project");
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
      const input = emptyInput(models);
      setSelectedName("");
      setDraft(input);
      setSnapshot("");
      return;
    }
    const version = versions.find((v) => v.versionName === versionName);
    if (version) {
      const input = toInput(version);
      setSelectedName(versionName);
      setDraft(input);
      setSnapshot(JSON.stringify(input));
    }
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const saved =
        selectedName === ""
          ? await createVersion(name, draft)
          : await updateVersion(name, selectedName, draft);
      const refreshed = await listVersions(name);
      setVersions(refreshed);
      setSelectedName(saved.versionName);
      const input = toInput(saved);
      setDraft(input);
      setSnapshot(JSON.stringify(input));
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save version");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-neutral-500">Loading…</p>;
  }
  if (error || !project) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
        {error ?? "Project not found"}
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <select
            value={selectedName}
            onChange={(e) => selectVersion(e.target.value)}
            className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700"
          >
            <option value="">+ New version</option>
            {versions.map((version) => (
              <option key={version.versionName} value={version.versionName}>
                v{version.versionName}
                {project.publishedVersion === version.versionName ? " (published)" : ""}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            {dirty && <span className="text-xs text-amber-600 dark:text-amber-400">unsaved</span>}
            <button
              type="button"
              onClick={save}
              disabled={saving || !draft.model}
              className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-strong disabled:opacity-50"
            >
              {saving ? "Saving…" : selectedName === "" ? "Create version" : "Save"}
            </button>
          </div>
        </div>

        {saveError && <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>}

        <VersionEditor
          projectName={project.name}
          projectType={project.projectType}
          models={models.filter((m) =>
            project.projectType === "image"
              ? m.capabilities.imageGeneration
              : !m.capabilities.imageGeneration,
          )}
          value={draft}
          onChange={setDraft}
        />
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Run</h2>
        <RunPanel
          projectName={name}
          versionName={dirty && selectedName === "" ? null : selectedName || null}
          projectType={project.projectType}
          systemPrompt={draft.systemPrompt}
          userPromptTemplate={draft.userPromptTemplate}
        />
      </section>
    </div>
  );
}
