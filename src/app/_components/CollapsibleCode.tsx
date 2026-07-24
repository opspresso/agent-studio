"use client";

import { CodeBlock } from "./CodeBlock";
import { CopyButton } from "./CopyButton";
import type { HighlightLanguage } from "./highlight";

/**
 * A titled, collapsed-by-default code block built on native <details>. Expanding
 * reveals the full syntax-highlighted content (no height clamp; wide content
 * scrolls horizontally).
 */
export function CollapsibleCode({
  title,
  code,
  language,
  copyLabel = "Copy",
}: {
  title: string;
  code: string;
  language: HighlightLanguage;
  copyLabel?: string;
}) {
  return (
    <details className="group rounded-md border border-neutral-200 dark:border-neutral-800">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium [&::-webkit-details-marker]:hidden">
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
          className="h-3.5 w-3.5 text-neutral-400 transition-transform group-open:rotate-90"
        >
          <path d="M7 5l6 5-6 5V5z" />
        </svg>
        {title}
      </summary>
      <div className="space-y-2 px-3 pb-3">
        <div className="flex justify-end">
          <CopyButton text={code} label={copyLabel} />
        </div>
        <CodeBlock language={language} code={code} />
      </div>
    </details>
  );
}
