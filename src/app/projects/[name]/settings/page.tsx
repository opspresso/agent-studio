"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { deleteProject, getProject, updateProject } from "../../lib/api";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { ResizableTextarea } from "@/app/_components/ResizableTextarea";
import { A2aSection } from "./A2aSection";
import { SlackSection } from "./SlackSection";

const inputClass =
  "mt-1 w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-neutral-700";

export default function SettingsPage() {
  const params = useParams<{ name: string }>();
  const name = params.name;
  const router = useRouter();

  const { data: session, isPending: sessionPending } = useSession();
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const project = await getProject(name);
        if (!cancelled) {
          setDisplayName(project.displayName);
          setDescription(project.description);
          setOwnerEmail(project.ownerEmail);
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

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateProject(name, { displayName, description });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete project "${name}" and all its versions? This cannot be undone.`)) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await deleteProject(name);
      router.push("/projects");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
      setDeleting(false);
    }
  }

  if (loading || sessionPending) {
    return <p className="text-sm text-neutral-500">Loading…</p>;
  }

  const isOwner = ownerEmail !== null && session?.user.email === ownerEmail;
  if (!isOwner) {
    return (
      <div className="max-w-xl rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
        Only the project owner ({ownerEmail ?? "unknown"}) can change these settings.
      </div>
    );
  }

  return (
    <div className="max-w-xl space-y-8">
      <form onSubmit={save} className="space-y-4">
        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </div>
        )}
        <label className="block">
          <span className="text-sm font-medium">Display name</span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Description</span>
          <ResizableTextarea
            value={description}
            onChange={setDescription}
            rows={4}
            className={inputClass}
          />
        </label>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-strong disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
          {saved && <span className="text-sm text-emerald-600 dark:text-emerald-400">Saved</span>}
        </div>
      </form>

      <SlackSection projectName={name} />

      <A2aSection projectName={name} />

      <CollapsibleSection
        title="Danger zone"
        titleClassName="text-sm font-semibold text-red-700 dark:text-red-400"
        className="border-red-200 dark:border-red-900/60"
      >
        <p className="text-sm text-neutral-500">
          Deleting a project removes all its versions and usage records.
        </p>
        <button
          type="button"
          onClick={remove}
          disabled={deleting}
          className="rounded-md border border-red-300 px-4 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
        >
          {deleting ? "Deleting…" : "Delete project"}
        </button>
      </CollapsibleSection>
    </div>
  );
}

      
