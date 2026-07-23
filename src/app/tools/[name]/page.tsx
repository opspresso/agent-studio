"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  deleteMcp,
  getMcp,
  testMcpConnection,
  updateMcp,
  type McpServer,
  type McpTool,
} from "../api";
import { HeaderRowsEditor, recordToRows, rowsToRecord, type HeaderRow } from "@/app/_components/HeaderRows";

export default function McpDetailPage() {
  const params = useParams<{ name: string }>();
  const name = params.name;
  const router = useRouter();

  const [server, setServer] = useState<McpServer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const [tools, setTools] = useState<McpTool[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setServer(await getMcp(name));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load MCP server");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  async function runTest() {
    setTesting(true);
    setTestError(null);
    setTools(null);
    try {
      setTools(await testMcpConnection(name));
    } catch (e) {
      setTestError(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setTesting(false);
    }
  }

  async function onDelete() {
    if (!confirm(`Delete MCP server "${name}"? This cannot be undone.`)) {
      return;
    }
    try {
      await deleteMcp(name);
      router.push("/tools");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete MCP server");
    }
  }

  if (loading) {
    return <p className="text-sm text-neutral-500">Loading…</p>;
  }

  if (error && !server) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      </div>
    );
  }

  if (!server) {
    return null;
  }

  const headerEntries = Object.entries(server.headers);

  return (
    <div className="space-y-6">
      <BackLink />

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{server.name}</h1>
          <p className="mt-1 text-sm text-neutral-500">{server.description}</p>
          <p className="mt-1 text-xs text-neutral-400">{server.url}</p>
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
        <EditMcpForm
          server={server}
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

          <section>
            <div className="mb-2 flex items-center gap-3">
              <h2 className="text-sm font-medium text-neutral-500">Connection</h2>
              <button
                type="button"
                onClick={runTest}
                disabled={testing}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                {testing ? "Testing…" : "Test connection"}
              </button>
            </div>

            {testError && (
              <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                {testError}
              </div>
            )}

            {tools && (
              <div>
                <p className="mb-2 text-sm text-neutral-500">
                  {tools.length} tool{tools.length === 1 ? "" : "s"} discovered.
                </p>
                {tools.length > 0 && (
                  <ul className="space-y-2">
                    {tools.map((tool) => (
                      <li
                        key={tool.name}
                        className="rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
                      >
                        <div className="font-mono text-sm font-medium">{tool.name}</div>
                        {tool.description && (
                          <p className="mt-1 text-sm text-neutral-500">{tool.description}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/tools" className="text-sm text-neutral-500 hover:text-brand">
      ← Back to tools
    </Link>
  );
}

function EditMcpForm({
  server,
  onCancel,
  onSaved,
}: {
  server: McpServer;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [url, setUrl] = useState(server.url);
  const [description, setDescription] = useState(server.description ?? "");
  const [rows, setRows] = useState<HeaderRow[]>(recordToRows(server.headers));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await updateMcp(server.name, {
        url,
        description,
        headers: rowsToRecord(rows),
      });
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
        <span className="text-sm font-medium">URL</span>
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
          className="mt-1 w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-neutral-700"
        />
      </label>

      <HeaderRowsEditor rows={rows} onChange={setRows} />
      <p className="text-xs text-neutral-400">
        Masked values (all asterisks) keep the stored secret. Type a new value to replace it.
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
