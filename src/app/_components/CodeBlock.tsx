"use client";

import { tokenize, type HighlightLanguage, type TokenType } from "./highlight";
import classes from "./CodeBlock.module.css";

const TOKEN_CLASS: Record<TokenType, string | undefined> = {
  comment: classes.comment,
  string: classes.string,
  keyword: classes.keyword,
  number: classes.number,
  function: classes.function,
  property: classes.property,
  variable: classes.variable,
  plain: undefined,
};

/**
 * Bordered, syntax-highlighted code block. The border keeps it distinct from the
 * card background in light theme. Content is shown in full — only horizontal
 * overflow scrolls; height grows with the content.
 */
export function CodeBlock({ language, code }: { language: HighlightLanguage; code: string }) {
  return (
    <pre className={classes.block}>
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
