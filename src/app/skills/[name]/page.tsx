"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { deleteSkill, getSkill, updateSkill, type Skill } from "../api";

export default function SkillDetailPage() {
  const params = useParams<{ name: string }>();
  const name = params.name;
  const router = useRouter();

  const [skill, setSkill] = useState<Skill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setSkill(await getSkill(name));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load skill");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  async function onDelete() {
    if (!confirm(`Delete skill "${name}"? This cannot be undone.`)) {
      return;
    }
    try {
      await deleteSkill(name);
      router.push("/skills");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete skill");
    }
  }

  if (loading) {
    return <p className="text-sm text-neutral-500">Loading…</p>;
  }

  if (error && !skill) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      </div>
    );
  }

  if (!skill) {
    return null;
  }

  return (
    <div className="space-y-6">
      <BackLink />

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{skill.name}</h1>
          <p className="mt-1 text-sm text-neutral-500">{skill.description}</p>
          {skill.source && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              Synced from {skill.source} — local edits are overwritten on the next sync.
            </p>
          )}
        </div>
        {!editing && (
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="rounded-md border border-red-300 px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {editing ? (
        <EditSkillForm
          skill={skill}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void refresh();
          }}
        />
      ) : (
        <section>
          <h2 className="mb-2 text-sm font-medium text-neutral-500">Content</h2>
          <div className="whitespace-pre-wrap rounded-lg border border-neutral-200 bg-white p-4 font-mono text-sm dark:border-neutral-800 dark:bg-neutral-900">
            {skill.content || <span className="text-neutral-400">No content.</span>}
          </div>
        </section>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/skills" className="text-sm text-neutral-500 hover:text-brand">
      ← Back to skills
    </Link>
  );
}

function EditSkillForm({
  skill,
  onCancel,
  onSaved,
}: {
  skill: Skill;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [description, setDescription] = useState(skill.description);
  const [content, setContent] = useState(skill.content);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await updateSkill(skill.name, { description, content });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block">
        <span className="text-sm font-medium">Description</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
          className="mt-1 w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-neutral-700"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Content (markdown)</span>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={16}
          className="mt-1 w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none dark:border-neutral-700"
        />
      </label>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-strong disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
