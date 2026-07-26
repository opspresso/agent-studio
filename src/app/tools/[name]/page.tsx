"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  deleteMcp,
  getMcp,
  testMcpConnection,
  discoverMcpAuth,
  clearMcpAuth,
  updateMcp,
  type McpServer,
  type McpTool,
} from "../api";
import { HeaderRowsEditor, recordToRows, rowsToRecord, type HeaderRow } from "@/app/_components/HeaderRows";
import { ResizableTextarea } from "@/app/_components/ResizableTextarea";
import { fieldClass, monoFieldClass } from "@/app/_components/formStyles";
import { buttonClass, textButtonClass } from "@/app/_components/buttonStyles";

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
              className={buttonClass("secondary")}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={onDelete}
              className={buttonClass("danger")}
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
          {server.content && (
            <section>
              <h2 className="mb-2 text-sm font-medium text-neutral-500">Content</h2>
              <div className="whitespace-pre-wrap rounded-lg border border-neutral-200 bg-white p-4 font-mono text-sm dark:border-neutral-800 dark:bg-neutral-900">
                {server.content}
              </div>
            </section>
          )}

          <OAuthSection server={server} onChanged={() => void refresh()} />

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
                className={buttonClass("secondary", "sm")}
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

/**
 * OAuth configuration for this registry entry (admin-only).
 *
 * This half is operator configuration — where the authorization server is —
 * shared by every project. The credentials that use it are per project and live
 * on the project page, which is what lets one entry serve a different app per
 * project.
 */
function OAuthSection({ server, onChanged }: { server: McpServer; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<string[] | null>(null);

  async function discover(authorizationServer?: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await discoverMcpAuth(server.name, authorizationServer);
      if (result.status === "choose") {
        // The resource advertises several; RFC 9728 puts the choice on us, and
        // taking the first would bind every project's tokens to it silently.
        setChoices(result.authorizationServers);
        return;
      }
      setChoices(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Discovery failed");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setError(null);
    try {
      await clearMcpAuth(server.name);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to clear OAuth configuration");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="mb-2 flex items-center gap-3">
        <h2 className="text-sm font-medium text-neutral-500">OAuth</h2>
        <button
          type="button"
          onClick={() => void discover()}
          disabled={busy}
          className={buttonClass("secondary", "sm")}
        >
          {busy ? "Discovering…" : server.auth ? "Rediscover" : "Discover"}
        </button>
        {server.auth && (
          <button
            type="button"
            onClick={() => void clear()}
            disabled={busy}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-neutral-700 dark:text-red-400 dark:hover:bg-red-950/30"
          >
            Clear
          </button>
        )}
      </div>

      {error && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {choices && (
        <div className="mb-2 space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30">
          <p>This resource advertises more than one authorization server. Choose one:</p>
          <div className="flex flex-wrap gap-2">
            {choices.map((issuer) => (
              <button
                key={issuer}
                type="button"
                onClick={() => void discover(issuer)}
                className="rounded-md border border-neutral-300 bg-white px-2 py-1 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900"
              >
                {issuer}
              </button>
            ))}
          </div>
        </div>
      )}

      {server.auth ? (
        <dl className="rounded-lg border border-neutral-200 bg-white p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900">
          {[
            ["Resource", server.auth.resource],
            ["Authorization server", server.auth.authorizationServer],
            ["Authorize", server.auth.authorizationEndpoint],
            ["Token", server.auth.tokenEndpoint],
            ["Registration", server.auth.registrationEndpoint ?? "not offered — clients must be registered by hand"],
            ["Client auth", server.auth.tokenEndpointAuthMethod],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4 border-b border-neutral-100 py-1 last:border-b-0 dark:border-neutral-800">
              <dt className="text-neutral-500">{label}</dt>
              <dd className="break-all text-right font-mono text-xs">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-neutral-400">
          Not configured. Discovery reads the server&apos;s published metadata; projects then
          connect their own credentials from their project page.
        </p>
      )}
    </section>
  );
}

function BackLink() {
  return (
    <Link href="/tools" className={textButtonClass}>
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
  const [content, setContent] = useState(server.content ?? "");
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
        content,
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
          className={fieldClass}
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Description</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One-line summary shown to the model"
          className={fieldClass}
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Content (markdown)</span>
        <ResizableTextarea
          value={content}
          onChange={setContent}
          rows={8}
          placeholder="Setup steps, caveats, links…"
          className={monoFieldClass}
        />
        <span className="mt-1 block text-xs text-neutral-400">
          Operator notes for the console. Not sent to the model — only the description is.
        </span>
      </label>

      <HeaderRowsEditor rows={rows} onChange={setRows} />
      <p className="text-xs text-neutral-400">
        Masked values keep the stored secret. Type a new value to replace it.
      </p>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={buttonClass("secondary")}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className={buttonClass("primary")}
        >
          {submitting ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
