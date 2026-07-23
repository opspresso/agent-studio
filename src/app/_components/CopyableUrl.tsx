"use client";

import { CopyButton } from "./CopyButton";

/** Shared URL display row: truncated monospace URL plus a copy button. */
export function CopyableUrl({ url }: { url: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code
        className="min-w-0 flex-1 truncate rounded bg-neutral-50 px-2 py-1.5 font-mono text-xs dark:bg-neutral-900"
        title={url}
      >
        {url}
      </code>
      <CopyButton text={url} />
    </div>
  );
}
