"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import {
  deleteVersion,
  getProject,
  listVersions,
  publishVersion,
  type Version,
} from "../../lib/api";

export default function VersionsPage() {
  const params = useParams<{ name: string }>();
  const name = params.name;

  const { data: session } = useSession();
  const [versions, setVersions] = useState<Version[]>([]);
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null);
  const [published, setPublished] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [project, vers] = await Promise.all([getProject(name), listVersions(name)]);
      setPublished(project.publishedVersion);
      setOwnerEmail(project.ownerEmail);
      setVersions([...vers].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load versions");
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function publish(versionName: string) {
    setBusy(versionName);
    setError(null);
    try {
      const project = await publishVersion(name, versionName);
      setPublished(project.publishedVersion);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to publish");
    } finally {
      setBusy(null);
    }
  }

  async function remove(versionName: string) {
    if (!confirm(`Delete version ${versionName}?`)) {
      return;
    }
    setBusy(versionName);
    setError(null);
    try {
      await deleteVersion(name, versionName);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return <p className="text-sm text-neutral-500">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {versions.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No versions yet. Create one in the Playground tab.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {versions.map((version) => {
            const isPublished = published === version.versionName;
            return (
              <li key={version.versionName} className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium">v{version.versionName}</span>
                    {isPublished && (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                        published
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-neutral-500">
                    {version.model} · {new Date(version.createdAt).toLocaleString()}
                  </div>
                </div>
                {ownerEmail !== null && session?.user.email === ownerEmail && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => publish(version.versionName)}
                      disabled={busy !== null || isPublished}
                      className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
                    >
                      {isPublished ? "Published" : "Publish"}
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(version.versionName)}
                      disabled={busy !== null}
                      className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
