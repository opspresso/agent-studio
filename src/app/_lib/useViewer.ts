"use client";

import { createContext, createElement, useContext } from "react";
import type { Viewer } from "@/lib/viewer";

/**
 * Re-exported so a page keeps importing the viewer's shape from the hook that
 * hands it over. The shape itself is owned by `src/lib/viewer.ts`, next to the
 * one derivation of its flags — type-only here, so nothing server-side follows
 * it into the browser bundle.
 */
export type { Viewer };

const ViewerContext = createContext<Viewer | null | undefined>(undefined);

export function ViewerProvider({
  viewer,
  children,
}: {
  viewer: Viewer | null;
  children: React.ReactNode;
}) {
  return createElement(ViewerContext.Provider, { value: viewer }, children);
}

/**
 * The signed-in user plus whether they are an admin.
 *
 * The root layout resolves this once before rendering and provides it to every
 * page. `useSession` already carries the email, but not the admin flag — and
 * the pages that gate on ownership need both, because an admin may mutate any
 * project. One hook so the gates cannot drift apart on what "may edit this"
 * means. `null` means nobody is signed in; it is never a loading sentinel.
 */
export function useViewer(): Viewer | null {
  const viewer = useContext(ViewerContext);
  if (viewer === undefined) {
    throw new Error("useViewer must be used inside ViewerProvider");
  }
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
