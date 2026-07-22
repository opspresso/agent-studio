"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toSlug } from "@/lib/slug";
import { createMcp, listMcps, type McpServer } from "./api";
import { HeaderRowsEditor, rowsToRecord, type HeaderRow } from "./HeaderRows";

export default function ToolsPage() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setServers(await listMcps());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load MCP servers");
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
          <h1 className="text-2xl font-semibold">Tools</h1>
          <p className="mt-1 text-sm text-neutral-500">
            MCP servers that expose tools to agents over streamable HTTP.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-strong"
        >
          Register MCP
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : servers.length === 0 ? (
        <p className="text-sm text-neutral-500">No MCP servers yet.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {servers.map((server) => (
            <li key={server.name}>
              <Link
                href={`/tools/${server.name}`}
                className="block h-full rounded-lg border border-neutral-200 bg-white p-4 transition hover:border-brand hover:shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="font-medium">{server.name}</div>
                <p className="mt-1 line-clamp-2 text-sm text-neutral-500">
                  {server.description || <span className="text-neutral-400">No description</span>}
                </p>
                <p className="mt-2 truncate text-xs text-neutral-400">{server.url}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {showModal && (
        <RegisterMcpModal
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

function RegisterMcpModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [rows, setRows] = useState<HeaderRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createMcp({
        name,
        url,
        description: description || undefined,
        headers: rowsToRecord(rows),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to register MCP server");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-neutral-200 bg-white p-6 shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="text-lg font-semibold">Register MCP server</h2>
        <form onSubmit={submit} className="mt-4 space-y-4">
          <label className="block">
            <span className="text-sm font-medium">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setName(toSlug(name))}
              placeholder="my-mcp"
              required
              className="mt-1 w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-neutral-700"
            />
            <span className="mt-1 block text-xs text-neutral-400">
              Lowercase letters, digits, and hyphens only.
            </span>
          </label>
          <label className="block">
            <span className="text-sm font-medium">URL</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
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
