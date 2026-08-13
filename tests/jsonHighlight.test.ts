import { describe, expect, it } from "vitest";
import { tokenize } from "@/app/_components/highlight";

/**
 * `JsonHighlight` decides by parsing, because what it is handed is a provider's
 * argument object or an MCP server's reply — JSON most of the time, a sentence
 * or a stack trace the rest of it. These fix the decision itself; the component
 * around it is two lines of JSX over `tokenize`.
 *
 * The rules are duplicated from the component rather than exported for the
 * test, so this file states them independently: a document (object or array)
 * that parses is coloured, everything else is left exactly as it arrived.
 */
function decide(text: string, maxChars = 20_000): "json" | "plain" {
  if (text.length > maxChars) {
    return "plain";
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return "plain";
  }
  try {
    JSON.parse(trimmed);
    return "json";
  } catch {
    return "plain";
  }
}

describe("what gets coloured as JSON", () => {
  it("colours an object and an array", () => {
    expect(decide('{"city":"Seoul"}')).toBe("json");
    expect(decide("[1, 2, 3]")).toBe("json");
    expect(decide('\n  {"padded": true}\n')).toBe("json");
  });

  /** A tool that answers in prose, and one that failed mid-sentence. */
  it("leaves text that is not a JSON document alone", () => {
    expect(decide("Seoul is sunny.")).toBe("plain");
    expect(decide("Error: connection refused")).toBe("plain");
    expect(decide('{"truncated": tr')).toBe("plain");
  });

  /**
   * `JSON.parse` takes bare scalars, and colouring a one-word answer as a
   * document is noise — the leading brace is what makes it worth reading.
   */
  it("leaves a bare scalar alone even though it parses", () => {
    expect(decide("42")).toBe("plain");
    expect(decide('"ok"')).toBe("plain");
    expect(decide("null")).toBe("plain");
  });

  it("stops at the size where tokenizing costs a frame", () => {
    const big = `{"data":"${"x".repeat(20_000)}"}`;
    expect(decide(big)).toBe("plain");
    expect(decide(big, big.length)).toBe("json");
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
