"use client";

import { useEffect, useState } from "react";

export interface Viewer {
  email: string;
  /** May mutate shared registries and app settings. */
  isAdmin: boolean;
  /**
   * May write a project owned by someone else. Not the same question as
   * {@link isAdmin} and not interchangeable with it — see `/api/me`.
   */
  isConfiguredAdmin: boolean;
}

/**
 * The signed-in user plus whether they are an admin.
 *
 * `useSession` already carries the email, but not the admin flag — and the
 * pages that gate on ownership need both, because an admin may mutate any
 * project. One hook so the four gates cannot drift apart on what "may edit
 * this" means. `null` while loading, so a gate can wait rather than flash the
 * read-only state at an admin.
 */
export function useViewer(): Viewer | null {
  const [viewer, setViewer] = useState<Viewer | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me")
      .then((res) => (res.ok ? (res.json() as Promise<Viewer>) : null))
      .then((data) => {
        if (!cancelled && data) {
          setViewer(data);
        }
      })
      .catch(() => {
        // Signed out, or the request failed; callers treat null as "cannot edit".
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return viewer;
}

/**
 * Whether this viewer may mutate a project owned by `ownerEmail`.
 *
 * `isConfiguredAdmin`, not `isAdmin`: this must mirror `assertProjectWritable`
 * exactly, and the two differ on a deployment that has no admin list — where
 * `isAdmin` is true for everyone and the server still allows only the owner.
 * Using the wrong one here does not open anything up, but it offers every user
 * an edit form for every project that 403s on save.
 */
export function canEditProject(viewer: Viewer | null, ownerEmail: string | null): boolean {
  return (
    viewer !== null &&
    ownerEmail !== null &&
    (viewer.isConfiguredAdmin || viewer.email === ownerEmail)
  );
}
