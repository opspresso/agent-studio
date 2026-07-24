"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  deleteAgent,
  getAgent,
  sendAgentMessage,
  updateAgent,
  type AgentProtocol,
  type ExternalAgent,
} from "../api";
import { HeaderRowsEditor, recordToRows, rowsToRecord, type HeaderRow } from "@/app/_components/HeaderRows";

export default function AgentDetailPage() {
  const params = useParams<{ name: string }>();
  const name = params.name;
  const router = useRouter();

  const [agent, setAgent] = useState<ExternalAgent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setAgent(await getAgent(name));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load agent");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  async function onDelete() {
    if (!confirm(`Delete agent "${name}"? This cannot be undone.`)) {
      return;
    }
    try {
      await deleteAgent(name);
      router.push("/agents");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete agent");
    }
  }

  if (loading) {
    return <p className="text-sm text-neutral-500">Loading…</p>;
  }

  if (error && !agent) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      </div>
    );
  }

  if (!agent) {
    return null;
  }

  const headerEntries = Object.entries(agent.headers);

  return (
    <div className="space-y-6">
      <BackLink />

      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{agent.name}</h1>
            <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
              {agent.protocol === "a2a" ? "A2A" : "OpenAI"}
            </span>
          </div>
          <p className="mt-1 text-sm text-neutral-500">{agent.description}</p>
          <p className="mt-1 text-xs text-neutral-400">{agent.url}</p>
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
        <EditAgentForm
          agent={agent}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void refresh();
          }}
        />
      ) : (
        <>
          <section>
            <h2 className="mb-2 text-sm font-medium text-neutral-500">Headers</h2>
            {headerEntries.length === 0 ? (
              <p className="text-sm text-neutral-400">None.</p>
            ) : (
              <ul className="rounded-lg border border-neutral-200 bg-white text-sm dark:border-neutral-800 dark:bg-neutral-900">
                {headerEntries.map(([key, value]) => (
                  <li
                    key={key}
                    className="flex items-center justify-between border-b border-neutral-100 px-4 py-2 last:border-b-0 dark:border-neutral-800"
                  >
                    <span className="font-mono">{key}</span>
                    <span className="font-mono text-neutral-400">{value}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <MessageTester name={agent.name} />
        </>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/agents" className="text-sm text-neutral-500 hover:text-brand">
      ← Back to agents
    </Link>
  );
}

function MessageTester({ name }: { name: string }) {
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    setReply(null);
    try {
      setReply(await sendAgentMessage(name, message));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <section>
      <h2 className="mb-2 text-sm font-medium text-neutral-500">Test message</h2>
      <form onSubmit={submit} className="space-y-3">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          required
          placeholder="Send one message to the agent…"
          className="w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-neutral-700"
        />
        <button
          type="submit"
          disabled={sending}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </form>

      {error && (
        <div className="mt-3 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {reply !== null && (
        <div className="mt-3">
          <h3 className="mb-1 text-xs font-medium text-neutral-500">Assistant reply</h3>
          <div className="whitespace-pre-wrap rounded-lg border border-neutral-200 bg-white p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900">
            {reply || <span className="text-neutral-400">Empty response.</span>}
          </div>
        </div>
      )}
    </section>
  );
}

function EditAgentForm({
  agent,
  onCancel,
  onSaved,
}: {
  agent: ExternalAgent;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [url, setUrl] = useState(agent.url);
  const [protocol, setProtocol] = useState<AgentProtocol>(agent.protocol ?? "openai");
  const [description, setDescription] = useState(agent.description);
  const [rows, setRows] = useState<HeaderRow[]>(recordToRows(agent.headers));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await updateAgent(agent.name, { url, protocol, description, headers: rowsToRecord(rows) });
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

      <HeaderRowsEditor rows={rows} onChange={setRows} emptyHint="No headers. Add one if the endpoint needs auth." />
      <p className="text-xs text-neutral-400">
        Masked values keep the stored secret. Type a new value to replace it.
      </p>

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
