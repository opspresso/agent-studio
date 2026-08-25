/**
 * Minimal, dependency-free syntax tokenizer for the API Reference code samples.
 * Only the four languages we emit (bash/python/javascript/json) are supported,
 * and the samples are fixed-shape, so a small regex tokenizer is enough — it is
 * not a general-purpose highlighter. Returns a flat token list the UI colors.
 */

export type TokenType =
  | "comment"
  | "string"
  | "keyword"
  | "number"
  | "function"
  | "property"
  | "variable"
  | "plain";

export interface Token {
  type: TokenType;
  value: string;
}

export type HighlightLanguage = "bash" | "python" | "javascript" | "json";

interface Rule {
  type: TokenType;
  re: RegExp;
}

// String bodies may embed $PLACEHOLDER tokens we want colored distinctly.
/**
 * How long an identifier may run before this stops looking for the `(` that
 * would make it a call.
 *
 * `\w*(?=\()` reads to the end of the input at every letter it starts on, then
 * gives the characters back one at a time re-asking for the bracket — so a run
 * of word characters with no bracket in it costs one pass per character.
 * Measured: 200,000 of them took 36 seconds, on the browser's one thread. The
 * highlighter only ever sees code this app wrote today, which is why nothing
 * has hit it; a bound is what keeps that from being load-bearing. No real
 * identifier comes near it.
 */
const MAX_IDENTIFIER_CHARS = 127;

const PLACEHOLDER_RE = /\$[A-Za-z_]\w*/g;

function pushString(tokens: Token[], value: string): void {
  let last = 0;
  PLACEHOLDER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_RE.exec(value))) {
    if (match.index > last) {
      tokens.push({ type: "string", value: value.slice(last, match.index) });
    }
    tokens.push({ type: "variable", value: match[0] });
    last = match.index + match[0].length;
  }
  if (last < value.length) {
    tokens.push({ type: "string", value: value.slice(last) });
  }
}

const BASH: Rule[] = [
  { type: "comment", re: /#[^\n]*/y },
  { type: "string", re: /'(?:[^'\\]|\\.)*'/y },
  { type: "string", re: /"(?:[^"\\]|\\.)*"/y },
  { type: "variable", re: /\$[A-Za-z_]\w*/y },
  { type: "keyword", re: /\bcurl\b/y },
  { type: "keyword", re: /--?[A-Za-z][\w-]*/y },
];

const PYTHON: Rule[] = [
  { type: "comment", re: /#[^\n]*/y },
  { type: "string", re: /'(?:[^'\\]|\\.)*'/y },
  { type: "string", re: /"(?:[^"\\]|\\.)*"/y },
  {
    type: "keyword",
    re: /\b(?:from|import|as|for|in|if|elif|else|def|return|class|with|await|async|and|or|not|None|True|False)\b/y,
  },
  { type: "number", re: /\b\d+(?:\.\d+)?\b/y },
  { type: "function", re: new RegExp(`[A-Za-z_]\\w{0,${MAX_IDENTIFIER_CHARS}}(?=\\()`, "y") },
];

const JAVASCRIPT: Rule[] = [
  { type: "comment", re: /\/\/[^\n]*/y },
  { type: "string", re: /'(?:[^'\\]|\\.)*'/y },
  { type: "string", re: /"(?:[^"\\]|\\.)*"/y },
  { type: "string", re: /`(?:[^`\\]|\\.)*`/y },
  {
    type: "keyword",
    re: /\b(?:import|from|const|let|var|await|async|new|for|of|return|function|if|else|true|false|null|console)\b/y,
  },
  { type: "number", re: /\b\d+(?:\.\d+)?\b/y },
  { type: "function", re: new RegExp(`[A-Za-z_]\\w{0,${MAX_IDENTIFIER_CHARS}}(?=\\()`, "y") },
];

const JSON_RULES: Rule[] = [
  { type: "property", re: /"(?:[^"\\]|\\.)*"(?=\s*:)/y },
  { type: "string", re: /"(?:[^"\\]|\\.)*"/y },
  { type: "keyword", re: /\b(?:true|false|null)\b/y },
  { type: "number", re: /-?\b\d+(?:\.\d+)?\b/y },
];

const RULES: Record<HighlightLanguage, Rule[]> = {
  bash: BASH,
  python: PYTHON,
  javascript: JAVASCRIPT,
  json: JSON_RULES,
};

export function tokenize(language: HighlightLanguage, code: string): Token[] {
  const rules = RULES[language];
  const tokens: Token[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain) {
      tokens.push({ type: "plain", value: plain });
      plain = "";
    }
  };

  let i = 0;
  outer: while (i < code.length) {
    for (const rule of rules) {
      rule.re.lastIndex = i;
      const match = rule.re.exec(code);
      if (match && match.index === i && match[0].length > 0) {
        flush();
        if (rule.type === "string") {
          pushString(tokens, match[0]);
        } else {
          tokens.push({ type: rule.type, value: match[0] });
        }
        i += match[0].length;
        continue outer;
      }
    }
    plain += code[i];
    i += 1;
  }
  flush();
  return tokens;
}
