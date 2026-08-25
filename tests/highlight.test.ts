import { describe, expect, it } from "vitest";
import { tokenize, type HighlightLanguage, type TokenType } from "@/app/_components/highlight";

function types(language: HighlightLanguage, code: string): Set<TokenType> {
  return new Set(tokenize(language, code).map((t) => t.type));
}

describe("tokenize — lossless", () => {
  const samples: Array<[HighlightLanguage, string]> = [
    ["bash", `curl -X POST 'https://x/y' \\\n  -H 'Authorization: Bearer $PROJECT_API_TOKEN'`],
    ["python", `from openai import OpenAI  # comment\nclient = OpenAI(api_key="$PROJECT_API_TOKEN")`],
    ["javascript", `import OpenAI from "openai";\nconst c = new OpenAI({ apiKey: "$PROJECT_API_TOKEN" });`],
    ["json", `{\n  "model": "openai/gpt-5-mini",\n  "usage": { "costUsd": 0.0001, "ok": true }\n}`],
  ];

  it("reconstructs the original code from tokens", () => {
    for (const [language, code] of samples) {
      const joined = tokenize(language, code)
        .map((t) => t.value)
        .join("");
      expect(joined).toBe(code);
    }
  });
});

describe("tokenize — classification", () => {
  it("bash: curl keyword, quoted string, and $placeholder inside the string", () => {
    const tokens = tokenize("bash", `curl -H 'Authorization: Bearer $PROJECT_API_TOKEN'`);
    expect(tokens.some((t) => t.type === "keyword" && t.value === "curl")).toBe(true);
    expect(tokens.some((t) => t.type === "string")).toBe(true);
    // The placeholder inside the quoted string is split out as a variable.
    expect(tokens.some((t) => t.type === "variable" && t.value === "$PROJECT_API_TOKEN")).toBe(true);
  });

  it("python: keywords, comment, and function call", () => {
    const t = types("python", `from openai import OpenAI  # c\nprint(x)`);
    expect(t.has("keyword")).toBe(true);
    expect(t.has("comment")).toBe(true);
    expect(t.has("function")).toBe(true);
  });

  it("javascript: comment, keyword, template/string", () => {
    const t = types("javascript", `// hi\nconst x = "a";`);
    expect(t.has("comment")).toBe(true);
    expect(t.has("keyword")).toBe(true);
    expect(t.has("string")).toBe(true);
  });

  it("json: property keys distinct from string values, plus numbers and literals", () => {
    const tokens = tokenize("json", `{ "k": "v", "n": 12, "b": true }`);
    expect(tokens.some((t) => t.type === "property")).toBe(true);
    expect(tokens.some((t) => t.type === "string" && t.value === '"v"')).toBe(true);
    expect(tokens.some((t) => t.type === "number")).toBe(true);
    expect(tokens.some((t) => t.type === "keyword" && t.value === "true")).toBe(true);
  });
});

/**
 * `\w*(?=\()` reads to the end of the input at every letter it starts on and
 * then gives the characters back one at a time, re-asking for the bracket — one
 * pass per character, on the browser's one thread. 200,000 word characters
 * measured 36 seconds before the bound.
 */
describe("a long run of word characters", () => {
  it("is tokenized in linear time", () => {
    for (const language of ["javascript", "python"] as const) {
      const started = process.hrtime.bigint();
      tokenize(language, "a".repeat(200_000));
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      expect(elapsed, `${language} took ${elapsed.toFixed(0)}ms`).toBeLessThan(2_000);
    }
  });

  it("still finds a call", () => {
    expect(tokenize("javascript", "doThing(1)")).toContainEqual({
      type: "function",
      value: "doThing",
    });
  });
});
