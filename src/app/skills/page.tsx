"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createSkill, listSkills, type Skill } from "./api";

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

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
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-strong"
        >
          New skill
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : skills.length === 0 ? (
        <p className="text-sm text-neutral-500">No skills yet. Create your first one.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {skills.map((skill) => (
            <li key={skill.name}>
              <Link
                href={`/skills/${skill.name}`}
                className="block h-full rounded-lg border border-neutral-200 bg-white p-4 transition hover:border-brand hover:shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="font-medium">{skill.name}</div>
                <p className="mt-1 line-clamp-3 text-sm text-neutral-500">{skill.description}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}

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
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-lg border border-neutral-200 bg-white p-6 shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="text-lg font-semibold">New skill</h2>
        <form onSubmit={submit} className="mt-4 space-y-4">
          <label className="block">
            <span className="text-sm font-medium">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-skill"
              required
              className="mt-1 w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-neutral-700"
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
              className="mt-1 w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-neutral-700"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Content (markdown)</span>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={8}
              placeholder="# Instructions…"
              className="mt-1 w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none dark:border-neutral-700"
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
      </div>
    </div>
  );
}
