"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createProject, listProjects, type Project, type ProjectType } from "./lib/api";

function TypeBadge({ type }: { type: ProjectType }) {
  const styles =
    type === "agent"
      ? "bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300"
      : "bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300";
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${styles}`}>{type}</span>;
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setProjects(await listProjects());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load projects");
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
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Prompt and agent projects with versioned configuration.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-strong"
        >
          New project
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : projects.length === 0 ? (
        <p className="text-sm text-neutral-500">No projects yet. Create your first one.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <li key={project.name}>
              <Link
                href={`/projects/${project.name}`}
                className="block h-full rounded-lg border border-neutral-200 bg-white p-4 transition hover:border-brand hover:shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{project.displayName || project.name}</span>
                  <TypeBadge type={project.projectType} />
                </div>
                <div className="mt-0.5 font-mono text-xs text-neutral-400">{project.name}</div>
                <p className="mt-2 line-clamp-3 text-sm text-neutral-500">{project.description}</p>
                {project.publishedVersion && (
                  <div className="mt-3 text-xs text-emerald-600 dark:text-emerald-400">
                    published: v{project.publishedVersion}
                  </div>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {showModal && (
        <CreateProjectModal
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

function CreateProjectModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [projectType, setProjectType] = useState<ProjectType>("llm");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createProject({ name, displayName: displayName || name, description, projectType });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-lg border border-neutral-200 bg-white p-6 shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="text-lg font-semibold">New project</h2>
        <form onSubmit={submit} className="mt-4 space-y-4">
          <label className="block">
            <span className="text-sm font-medium">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
              required
              className="mt-1 w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-neutral-700"
            />
            <span className="mt-1 block text-xs text-neutral-400">
              Lowercase letters, digits, and hyphens only. Immutable identifier.
            </span>
          </label>
          <label className="block">
            <span className="text-sm font-medium">Display name</span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="My Project"
              className="mt-1 w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-neutral-700"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-neutral-700"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Type</span>
            <select
              value={projectType}
              onChange={(e) => setProjectType(e.target.value as ProjectType)}
              className="mt-1 w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-neutral-700"
            >
              <option value="llm">llm — single-shot prompt</option>
              <option value="agent">agent — multi-turn tool loop</option>
            </select>
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
