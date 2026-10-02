"use client";

import { createContext, createElement, useContext } from "react";
import { isAgentOwner } from "@/domain/agent/access";
import { tierMayEdit, tierMayRunAgents } from "@/domain/member/tiers";
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

/** The root layout supplies one viewer for all console permission controls. */
export function useViewer(): Viewer | null {
  const viewer = useContext(ViewerContext);
  if (viewer === undefined) {
    throw new Error("useViewer must be used inside ViewerProvider");
  }
  return viewer;
}

/** Member access permits management only of the viewer's own Agents. */
export function canEditAgent(viewer: Viewer | null, ownerEmail: string | null): boolean {
  return (
    viewer !== null &&
    tierMayEdit(viewer.tier) &&
    ownerEmail !== null &&
    isAgentOwner({ ownerEmail }, viewer.email)
  );
}

/** Execution is available to members; visibility is enforced by each Agent's server gate. */
export function canRunAgents(viewer: Viewer | null): boolean {
  return viewer !== null && tierMayRunAgents(viewer.tier);
}
