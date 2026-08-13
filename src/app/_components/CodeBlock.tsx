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
 * The coloured spans, without a container.
 *
 * Split out because the container is what differs: this block scrolls
 * horizontally inside a border, while a tool call's arguments wrap inside the
 * chat's narrow `Code` element. Only the colours are shared, and they are
 * shared rather than copied — the token-to-class table above is the one place
 * that decides what a string looks like.
 */
export function CodeTokens({ language, code }: { language: HighlightLanguage; code: string }) {
  return (
    <>
      {tokenize(language, code).map((token, index) =>
        token.type === "plain" ? (
          token.value
        ) : (
          <span key={index} className={TOKEN_CLASS[token.type]}>
            {token.value}
          </span>
        ),
      )}
    </>
  );
}

/**
 * Bordered, syntax-highlighted code block. The border keeps it distinct from the
 * card background in light theme. Content is shown in full — only horizontal
 * overflow scrolls; height grows with the content.
 */
export function CodeBlock({ language, code }: { language: HighlightLanguage; code: string }) {
  return (
    <pre className={classes.block}>
      <code>
        <CodeTokens language={language} code={code} />
      </code>
    </pre>
  );
}
