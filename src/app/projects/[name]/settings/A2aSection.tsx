"use client";

import { useEffect, useState } from "react";
import { CopyableUrl } from "@/app/_components/CopyableUrl";
import { getProjectA2a } from "../../lib/api";
import type { ProjectA2aView } from "../../lib/api";

export function A2aSection({ projectName }: { projectName: string }) {
  const [view, setView] = useState<ProjectA2aView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getProjectA2a(projectName)
      .then((v) => !cancelled && setView(v))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Load failed"));
    return () => {
      cancelled = true;
    };
  }, [projectName]);

  if (!view) {
    return error ? <p className="text-sm text-red-600">{error}</p> : null;
  }

  const ready = view.enabled && view.published;

  return (
    <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">A2A</h2>
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            ready
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-neutral-200 text-neutral-500 dark:bg-neutral-800"
          }`}
        >
          {ready ? "exposed" : view.enabled ? "not published" : "disabled"}
        </span>
      </div>

      <p className="text-xs leading-relaxed text-neutral-500">
        The published version is exposed as an A2A agent. Share the Agent Card URL with external
        systems; callers authenticate with the <code className="font-mono">X-A2A-Key</code> header.
      </p>

      {!view.enabled && (
        <p className="text-sm text-neutral-500">
          Set <code className="font-mono text-xs">A2A_API_KEY</code> on the server to enable A2A
          endpoints.
        </p>
      )}
      {view.enabled && !view.published && (
        <p className="text-sm text-neutral-500">Publish a version to expose this project over A2A.</p>
      )}

      {view.cardUrl && <CopyableUrl url={view.cardUrl} />}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}
