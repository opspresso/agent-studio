"use client";

import { useCallback, useSyncExternalStore } from "react";
import { runStore, type RunEntry } from "./runStore";

/**
 * The only React in `_lib/`, kept to the few lines that cannot be tested without
 * a DOM. Everything with logic in it lives in `runStore.ts`.
 *
 * `getServerSnapshot` is required, not optional: these hooks run in client
 * components that a server component renders, and React throws without one. Both
 * server snapshots are constants, and both match the first client render — a
 * fresh page load has an empty store in that tab too.
 */

const noEntry = (): RunEntry | undefined => undefined;
const NO_RUNS: readonly string[] = Object.freeze([]);
const noRuns = (): readonly string[] => NO_RUNS;

export function useRunEntry(key: string | null): RunEntry | undefined {
  // Returns the stored object itself. Deriving a new one here — even
  // `{ live, pendingUser }` — allocates on every call, which React rejects as an
  // uncached snapshot.
  const getSnapshot = useCallback(
    () => (key === null ? undefined : runStore.get(key)),
    [key],
  );
  return useSyncExternalStore(runStore.subscribe, getSnapshot, noEntry);
}

export function useRunningChats(): readonly string[] {
  return useSyncExternalStore(runStore.subscribe, runStore.runningChatIds, noRuns);
}
