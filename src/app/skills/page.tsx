"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toSlug } from "@/shared/slug";
import { createSkill, listSkills, type Skill } from "./api";
import { ResizableTextarea } from "@/app/_components/ResizableTextarea";
import { Modal } from "@/app/_components/Modal";
import { fieldClass, monoFieldClass } from "@/app/_components/formStyles";
import { CardGrid, linkCardClass } from "@/app/_components/CardGrid";

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setSkills(await listSkills());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load skills");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Skills</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Markdown behavior instructions loaded on demand by the agent engine.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {syncStatus && <span className="text-xs text-neutral-500">{syncStatus}</span>}
          <button
            type="button"
            disabled={syncing}
            onClick={async () => {
              setSyncing(true);
              setSyncStatus(null);
              setError(null);
              try {
                const res = await fetch("/api/skills/sync", { method: "POST" });
                const data = (await res.json()) as {
                  synced?: string[];
                  unchanged?: number;
                  error?: string;
                };
                if (!res.ok) {
                  setError(data.error ?? "Sync failed");
                } else {
                  setSyncStatus(
                    `Synced ${data.synced?.length ?? 0} · unchanged ${data.unchanged ?? 0}`,
                  );
                  await refresh();
                }
              } catch (e) {
                setError(e instanceof Error ? e.message : "Sync failed");
              } finally {
                setSyncing(false);
              }
            }}
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            {syncing ? "Syncing…" : "Sync from GitHub"}
          </button>
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-strong"
          >
            New skill
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      <CardGrid
        loading={loading}
        empty={skills.length === 0}
        emptyText="No skills yet. Create your first one."
      >
        {skills.map((skill) => (
          <li key={skill.name}>
            <Link
              href={`/skills/${skill.name}`}
              className={linkCardClass}
            >
              <div className="font-medium">{skill.name}</div>
              <p className="mt-1 line-clamp-3 text-sm text-neutral-500">{skill.description}</p>
            </Link>
          </li>
        ))}
      </CardGrid>

      {showModal && (
        <CreateSkillModal
          onClose={() => setShowModal(false)}
          onCreated={() => {
            setShowModal(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function CreateSkillModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createSkill({ name, description, content });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create skill");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="New skill" onClose={onClose} size="md">
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setName(toSlug(name))}
            placeholder="my-skill"
            required
            className={fieldClass}
          />
          <span className="mt-1 block text-xs text-neutral-400">
            Lowercase letters, digits, and hyphens only.
          </span>
        </label>
        <label className="block">
          <span className="text-sm font-medium">Description</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="One-line summary shown to the model"
            required
            className={fieldClass}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Content (markdown)</span>
          <ResizableTextarea
            value={content}
            onChange={setContent}
            rows={8}
            placeholder="# Instructions…"
            className={monoFieldClass}
          />
        </label>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-strong disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
