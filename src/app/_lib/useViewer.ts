"use client";

import { useEffect, useState } from "react";
import type { Viewer } from "@/lib/viewer";
import { redirectToLogin } from "./authRedirect";

/**
 * Re-exported so a page keeps importing the viewer's shape from the hook that
 * hands it over. The shape itself is owned by `src/lib/viewer.ts`, next to the
 * one derivation of its flags — type-only here, so nothing server-side follows
 * it into the browser bundle.
 */
export type { Viewer };

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
      .then((res) => {
        if (res.status === 401) {
          redirectToLogin();
          return null;
        }
        return res.ok ? (res.json() as Promise<Viewer>) : null;
      })
      .then((data) => {
        if (!cancelled && data) {
          setViewer(data);
        }
      })
      .catch(() => {
        // A non-authentication failure leaves the caller in its loading/read-only state.
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
