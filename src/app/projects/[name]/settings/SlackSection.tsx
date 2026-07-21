"use client";

import { useEffect, useState } from "react";
import {
  disconnectProjectSlack,
  getProjectSlack,
  testProjectSlack,
  updateProjectSlack,
} from "../../lib/api";
import type { ProjectSlackView } from "../../lib/api";

const inputClass =
  "mt-1 w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none dark:border-neutral-700";

export function SlackSection({ projectName }: { projectName: string }) {
  const [view, setView] = useState<ProjectSlackView | null>(null);
  const [botToken, setBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getProjectSlack(projectName)
      .then((v) => {
        if (!cancelled) {
          setView(v);
          setBotToken(v.botToken);
          setSigningSecret(v.signingSecret);
          setEnabled(v.enabled);
        }
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Load failed"));
    return () => {
      cancelled = true;
    };
  }, [projectName]);

  if (!view) {
    return error ? <p className="text-sm text-red-600">{error}</p> : null;
  }

  async function save() {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const next = await updateProjectSlack(projectName, { botToken, signingSecret, enabled });
      setView(next);
      setBotToken(next.botToken);
      setSigningSecret(next.signingSecret);
      setEnabled(next.enabled);
      setStatus("Saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setStatus(null);
    setError(null);
    const result = await testProjectSlack(projectName);
    if (result.ok) {
      setStatus(`Connected: ${result.team} (bot: ${result.botUser})`);
    } else {
      setError(result.error ?? "Connection test failed");
    }
    setBusy(false);
  }

  async function disconnect() {
    if (!window.confirm("Remove the Slack bot credentials for this project?")) {
      return;
    }
    setBusy(true);
    try {
      await disconnectProjectSlack(projectName);
      const next = await getProjectSlack(projectName);
      setView(next);
      setBotToken("");
      setSigningSecret("");
      setEnabled(false);
      setStatus("Disconnected");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Slack bot
        </h2>
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            view.enabled
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-neutral-200 text-neutral-500 dark:bg-neutral-800"
          }`}
        >
          {view.enabled ? "enabled" : view.configured ? "configured (off)" : "not connected"}
        </span>
      </div>

      <p className="text-xs leading-relaxed text-neutral-500">
        Create a dedicated Slack app for this project from the manifest below
        (api.slack.com/apps → Create New App → From a manifest), install it, then paste the
        bot token and signing secret here.
      </p>

      <details className="rounded-md border border-neutral-200 dark:border-neutral-800">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium">App manifest</summary>
        <div className="px-3 pb-3">
          <pre className="max-h-64 overflow-auto rounded bg-neutral-50 p-2 text-[11px] dark:bg-neutral-900">
            {JSON.stringify(view.manifest, null, 2)}
          </pre>
          <button
            type="button"
            onClick={() => navigator.clipboard.writeText(JSON.stringify(view.manifest, null, 2))}
            className="mt-2 rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Copy manifest
          </button>
        </div>
      </details>

      <label className="block">
        <span className="text-sm font-medium">Bot token</span>
        <input
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
          placeholder="xoxb-…"
          className={inputClass}
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Signing secret</span>
        <input
          value={signingSecret}
          onChange={(e) => setSigningSecret(e.target.value)}
          placeholder="Signing secret from Basic Information"
          className={inputClass}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enable event handling at <code className="font-mono text-xs">{view.eventsPath}</code>
      </label>

      {status && <p className="text-sm text-emerald-600 dark:text-emerald-400">{status}</p>}
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-md bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-strong disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          onClick={test}
          disabled={busy || !view.configured}
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          Test connection
        </button>
        {view.configured && (
          <button
            type="button"
            onClick={disconnect}
            disabled={busy}
            className="ml-auto rounded-md border border-red-300 px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:hover:bg-red-950/40"
          >
            Disconnect
          </button>
        )}
      </div>
    </section>
  );
}
