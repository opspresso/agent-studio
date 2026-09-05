import { describe, expect, it } from "vitest";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JsonHighlight } from "@/app/_components/JsonHighlight";
import { tokenize } from "@/app/_components/highlight";

function render(text: string): string {
  return renderToStaticMarkup(createElement(JsonHighlight, { text }));
}

function plain(text: string): string {
  return renderToStaticMarkup(createElement(Fragment, null, text));
}

describe("what gets coloured as JSON", () => {
  it("colours an object and an array", () => {
    for (const text of ['{"city":"Seoul"}', "[1, 2, 3]", '\n  {"padded": true}\n']) {
      const html = render(text);
      expect(html).toContain("<span");
      expect(html.replace(/<\/?span\b[^>]*>/g, "")).toBe(plain(JSON.stringify(JSON.parse(text), null, 2)));
    }
  });

  /** A tool that answers in prose, and one that failed mid-sentence. */
  it("leaves text that is not a JSON document alone", () => {
    expect(render("Seoul is sunny.")).toBe(plain("Seoul is sunny."));
    expect(render("Error: connection refused")).toBe(plain("Error: connection refused"));
    expect(render('{"truncated": tr')).toBe(plain('{"truncated": tr'));
  });

  /**
   * `JSON.parse` takes bare scalars, and colouring a one-word answer as a
   * document is noise — the leading brace is what makes it worth reading.
   */
  it("leaves a bare scalar alone even though it parses", () => {
    expect(render("42")).toBe(plain("42"));
    expect(render('"ok"')).toBe(plain('"ok"'));
    expect(render("null")).toBe(plain("null"));
  });

  it("stops at the size where tokenizing costs a frame", () => {
    const big = `{"data":"${"x".repeat(20_000)}"}`;
    expect(render(big)).toBe(plain(big));
  });

  /** The colours themselves: keys and values are separate token types. */
  it("gives a key and its value different token types", () => {
    const tokens = tokenize("json", '{\n  "city": "Seoul",\n  "days": 3\n}');
    const types = new Map(tokens.map((t) => [t.value, t.type]));
    expect(types.get('"city"')).toBe("property");
    expect(types.get('"Seoul"')).toBe("string");
    expect(types.get("3")).toBe("number");
  });
});
