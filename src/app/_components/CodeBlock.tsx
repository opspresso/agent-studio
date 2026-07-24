"use client";

import { tokenize, type HighlightLanguage, type TokenType } from "./highlight";

const TOKEN_CLASS: Record<TokenType, string> = {
  comment: "text-neutral-400 italic dark:text-neutral-500",
  string: "text-emerald-700 dark:text-emerald-400",
  keyword: "text-violet-700 dark:text-violet-400",
  number: "text-amber-700 dark:text-amber-400",
  function: "text-blue-700 dark:text-blue-400",
  property: "text-sky-700 dark:text-sky-300",
  variable: "text-rose-600 dark:text-rose-400",
  plain: "",
};

/**
 * Bordered, syntax-highlighted code block. The border keeps it distinct from the
 * card background in light theme. Content is shown in full — only horizontal
 * overflow scrolls; height grows with the content.
 */
export function CodeBlock({ language, code }: { language: HighlightLanguage; code: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs leading-relaxed text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
      <code>
        {tokenize(language, code).map((token, index) =>
          token.type === "plain" ? (
            token.value
          ) : (
            <span key={index} className={TOKEN_CLASS[token.type]}>
              {token.value}
            </span>
          ),
        )}
      </code>
    </pre>
  );
}
