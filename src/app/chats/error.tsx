"use client";

/**
 * The chat segment's own boundary, so a thread that throws does not take the
 * sidebar with it.
 *
 * `app/error.tsx` would catch this too, but it replaces everything under the
 * root layout — including `chats/layout.tsx`, which is where the chat list
 * lives. A reader whose open thread failed to render should still be able to
 * click another one.
 */

import { ErrorCard } from "@/app/_components/ErrorCard";

export default function ChatError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorCard error={error} reset={reset} />;
}
