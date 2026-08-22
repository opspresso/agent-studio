"use client";

/**
 * What a page shows when its render threw.
 *
 * Without this file a throw anywhere in the tree unmounts the whole console —
 * the shell, the navigation and the chat sidebar with it — and leaves Next's
 * default screen, from which the only way back is the browser's own reload.
 * Sitting at `app/`, it renders *inside* the root layout, so the shell stays
 * and the reader loses one page rather than the application.
 *
 * `reset()` re-renders the segment without a reload, which is the right first
 * try for the errors that actually reach here: a response shape a page did not
 * expect, a render that raced a navigation.
 */

import { ErrorCard } from "@/app/_components/ErrorCard";

export default function PageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorCard error={error} reset={reset} />;
}
