"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CopyableUrl } from "@/app/_components/CopyableUrl";
import { toSlug } from "@/lib/slug";
import {
  createAgent,
  listA2aProjects,
  listAgents,
  type A2aProjectListView,
  type AgentProtocol,
  type ExternalAgent,
} from "./api";
import { HeaderRowsEditor, rowsToRecord, type HeaderRow } from "./HeaderRows";

export default function AgentsPage() {
  const [agents, setAgents] = useState<ExternalAgent[]>([]);
  const [a2aProjects, setA2aProjects] = useState<A2aProjectListView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [agentList, projectList] = await Promise.all([listAgents(), listA2aProjects()]);
      setAgents(agentList);
      setA2aProjects(projectList);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load agents");
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
          <h1 className="text-2xl font-semibold">Agents</h1>
          <p className="mt-1 text-sm text-neutral-500">
            External OpenAI-compatible agent endpoints, usable as remote subagents.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-strong"
        >
          Register agent
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : agents.length === 0 ? (
        <p className="text-sm text-neutral-500">No external agents yet.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <li key={agent.name}>
              <Link
                href={`/agents/${agent.name}`}
                className="block h-full rounded-lg border border-neutral-200 bg-white p-4 transition hover:border-brand hover:shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{agent.name}</span>
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                    {agent.protocol === "a2a" ? "A2A" : "OpenAI"}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-neutral-500">{agent.description}</p>
                <p className="mt-2 truncate text-xs text-neutral-400">{agent.url}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {!loading && a2aProjects && a2aProjects.projects.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Studio projects (A2A)</h2>
            <p className="mt-1 text-sm text-neutral-500">
              {a2aProjects.enabled
                ? "Published projects, exposed as A2A agents — share the Agent Card URL, no registration needed."
                : "Published projects. Set A2A_API_KEY on the server to expose them as A2A agents."}
            </p>
          </div>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {a2aProjects.projects.map((project) => (
              <li
                key={project.name}
                className="flex h-full flex-col rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="flex items-center gap-2">
                  <Link href={`/projects/${project.name}`} className="font-medium hover:text-brand">
                    {project.displayName || project.name}
                  </Link>
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                    A2A
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-neutral-500">{project.description}</p>
                {a2aProjects.enabled && (
                  <div className="mt-2">
                    <CopyableUrl url={project.cardUrl} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {showModal && (
        <RegisterAgentModal
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

function RegisterAgentModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [protocol, setProtocol] = useState<AgentProtocol>("openai");
  const [description, setDescription] = useState("");
  const [rows, setRows] = useState<HeaderRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createAgent({ name, url, protocol, description, headers: rowsToRecord(rows) });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to register agent");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-neutral-200 bg-white p-6 shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="text-lg font-semibold">Register external agent</h2>
        <form onSubmit={submit} className="mt-4 space-y-4">
          <label className="block">
            <span className="text-sm font-medium">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setName(toSlug(name))}
              placeholder="my-agent"
              required
              className="mt-1 w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-neutral-700"
            />
            <span className="mt-1 block text-xs text-neutral-400">
              Lowercase letters, digits, and hyphens only.
            </span>
          </label>
          <label className="block">
            <span className="text-sm font-medium">Protocol</span>
            <select
              value={protocol}
              onChange={(e) => setProtocol(e.target.value as AgentProtocol)}
              className="mt-1 w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-neutral-700"
            >
              <option value="openai">OpenAI-compatible</option>
              <option value="a2a">A2A</option>
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-medium">{protocol === "a2a" ? "Agent Card URL" : "URL"}</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={
                protocol === "a2a"
                  ? "https://example.com/.well-known/agent-card.json"
                  : "https://example.com/v1/chat/completions"
              }
              type="url"
              required
              className="mt-1 w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-neutral-700"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Description</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              className="mt-1 w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-neutral-700"
            />
          </label>

          <HeaderRowsEditor rows={rows} onChange={setRows} />

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
              {submitting ? "Registering…" : "Register"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
