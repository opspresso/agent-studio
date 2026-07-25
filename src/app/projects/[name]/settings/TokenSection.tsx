"use client";

import { useEffect, useState } from "react";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { CopyButton } from "@/app/_components/CopyButton";
import {
  generateProjectToken,
  getProjectToken,
  revealProjectToken,
  revokeProjectToken,
  type ProjectTokenStatus,
} from "../../lib/api";

export function TokenSection({ projectName }: { projectName: string }) {
  const [status, setStatus] = useState<ProjectTokenStatus | null>(null);
  // The plaintext token, either just generated or read back on request. Held in
  // component state only, so leaving the page hides it again.
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [freshlyIssued, setFreshlyIssued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getProjectToken(projectName)
      .then((s) => !cancelled && setStatus(s))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Load failed"));
    return () => {
      cancelled = true;
    };
  }, [projectName]);

  async function generate(regenerate: boolean) {
    if (regenerate && !confirm("Regenerate the token? The current token stops working immediately.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { token, masked, createdAt } = await generateProjectToken(projectName);
      setRawToken(token);
      setFreshlyIssued(true);
      setStatus({ configured: true, masked, createdAt, revealable: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate token");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!confirm("Revoke the token? Callers using it will stop working immediately.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await revokeProjectToken(projectName);
      setStatus({ configured: false });
      setRawToken(null);
      setFreshlyIssued(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke token");
    } finally {
      setBusy(false);
    }
  }

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      setRawToken(await revealProjectToken(projectName));
      setFreshlyIssued(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reveal token");
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return error ? <p className="text-sm text-red-600">{error}</p> : null;
  }

  return (
    <CollapsibleSection
      title="API token"
      badge={
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            status.configured
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-neutral-200 text-neutral-500 dark:bg-neutral-800"
          }`}
        >
          {status.configured ? "set" : "none"}
        </span>
      }
    >
      <p className="text-xs leading-relaxed text-neutral-500">
        A token lets external callers run this project&apos;s execution APIs (predict, chat
        completions, agent) with an <code className="font-mono">Authorization: Bearer</code> header
        instead of a browser session. It is scoped to this project and stored encrypted, so you
        can read it back here.
      </p>

      {rawToken && (
        <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-950/30">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1.5 font-mono text-xs dark:bg-neutral-900">
              {rawToken}
            </code>
            <CopyButton text={rawToken} />
            <button
              type="button"
              onClick={() => setRawToken(null)}
              className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              Hide
            </button>
          </div>
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {freshlyIssued
              ? "This token is now live; the previous one stopped working."
              : "Anyone holding this token can run this project's APIs."}
          </p>
        </div>
      )}

      {status.configured && !rawToken && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            {status.masked && (
              <code className="min-w-0 flex-1 truncate rounded bg-neutral-100 px-2 py-1.5 font-mono text-xs dark:bg-neutral-800">
                {status.masked}
              </code>
            )}
            {status.revealable !== false && (
              <button
                type="button"
                onClick={reveal}
                disabled={busy}
                className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                Reveal
              </button>
            )}
          </div>
          <p className="text-sm text-neutral-500">
            A token is set{status.createdAt ? ` (created ${status.createdAt.slice(0, 10)})` : ""}.
            {status.revealable === false
              ? " It was issued before tokens could be shown again, so only its hash is stored — regenerate to get one you can read back."
              : ""}
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {status.configured ? (
          <>
            <button
              type="button"
              onClick={() => generate(true)}
              disabled={busy}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              {busy ? "Working…" : "Regenerate"}
            </button>
            <button
              type="button"
              onClick={revoke}
              disabled={busy}
              className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              Revoke
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => generate(false)}
            disabled={busy}
            className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-strong disabled:opacity-50"
          >
            {busy ? "Working…" : "Generate token"}
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </CollapsibleSection>
  );
}
