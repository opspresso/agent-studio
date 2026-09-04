import { describe, expect, it } from "vitest";
import type { DocumentExtractor } from "@/domain/llm/documentExtractor";
import { toEngineMessages as map } from "@/application/agui/input";
import type { AguiContext, AguiMessage } from "@/domain/agui/types";

const extractor: DocumentExtractor = {
  extract: async ({ bytes, name }) => ({ text: `[${name}: ${Buffer.from(bytes).toString("utf8")}]` }),
};

function toEngineMessages(
  messages: readonly AguiMessage[],
  context: readonly AguiContext[],
  state: unknown = undefined,
  warnings: string[] = [],
) {
  return map(messages, context, state, { documents: extractor, warnings });
}

describe("toEngineMessages", () => {
  it("maps every protocol role onto the engine's shapes", async () => {
    expect(
      await toEngineMessages(
        [
          { id: "1", role: "developer", content: "be brief" },
          { id: "2", role: "system", content: "you are a bot" },
          { id: "3", role: "user", content: "hi" },
          {
            id: "4",
            role: "assistant",
            content: "checking",
            toolCalls: [{ id: "c1", type: "function", function: { name: "getWeather", arguments: "{}" } }],
          },
          { id: "5", role: "tool", content: "sunny", toolCallId: "c1" },
          { id: "6", role: "tool", content: "", toolCallId: "c2", error: "timed out" },
          { id: "7", role: "assistant" },
          { id: "8", role: "reasoning", content: "hmm" },
          { id: "9", role: "activity", activityType: "PLAN", content: { steps: [] } },
        ],
        [],
      ),
    ).toEqual([
      { role: "system", content: "be brief" },
      { role: "system", content: "you are a bot" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "checking",
        tool_calls: [{ id: "c1", type: "function", function: { name: "getWeather", arguments: "{}" } }],
      },
      { role: "tool", content: "sunny", tool_call_id: "c1" },
      { role: "tool", content: "Error: timed out", tool_call_id: "c2" },
      { role: "assistant", content: null },
    ]);
  });

  it("turns a user turn's parts into text and data-url image parts", async () => {
    expect(
      await toEngineMessages(
        [
          {
            id: "1",
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } },
            ],
          },
        ],
        [],
      ),
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ]);
  });

  it("puts the application's context ahead of the history as one system turn", async () => {
    expect(
      await toEngineMessages(
        [{ id: "1", role: "user", content: "hi" }],
        [
          { description: "Current page", value: "/orders/42" },
          { description: "Locale", value: "ko-KR" },
        ],
      ),
    ).toEqual([
      {
        role: "system",
        content: "Context provided by the application:\n- Current page: /orders/42\n- Locale: ko-KR",
      },
      { role: "user", content: "hi" },
    ]);
  });
});

describe("toEngineMessages — the client's record of the thinking", () => {
  it("puts a reasoning message back on the assistant turn that follows it", async () => {
    expect(
      await toEngineMessages(
        [
          { id: "1", role: "user", content: "hi" },
          { id: "2", role: "reasoning", content: "first thought" },
          { id: "3", role: "reasoning", content: "second thought" },
          {
            id: "4",
            role: "assistant",
            toolCalls: [{ id: "c1", type: "function", function: { name: "showMap", arguments: "{}" } }],
          },
          { id: "5", role: "tool", content: "shown", toolCallId: "c1" },
          // Thinking that precedes nothing of the assistant's is dropped.
          { id: "6", role: "reasoning", content: "stray" },
          { id: "7", role: "user", content: "thanks" },
          { id: "8", role: "assistant", content: "welcome" },
        ],
        [],
      ),
    ).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "showMap", arguments: "{}" } }],
        reasoning_content: "first thought\n\nsecond thought",
      },
      { role: "tool", content: "shown", tool_call_id: "c1" },
      { role: "user", content: "thanks" },
      { role: "assistant", content: "welcome" },
    ]);
  });
});

describe("toEngineMessages — documents and state", () => {
  it("reads a document part to text that leads the turn, naming it from metadata", async () => {
    const warnings: string[] = [];
    const messages = await toEngineMessages(
      [
        {
          id: "1",
          role: "user",
          content: [
            { type: "text", text: "summarise this" },
            {
              type: "document",
              source: { type: "data", value: Buffer.from("hello file").toString("base64"), mimeType: "text/plain" },
              metadata: { name: "notes.txt" },
            },
          ],
        },
      ],
      [],
      undefined,
      warnings,
    );
    const content = messages[0]?.content;
    expect(typeof content).toBe("string");
    expect(content).toContain("[notes.txt: hello file]");
    expect((content as string).indexOf("[notes.txt")).toBeLessThan((content as string).indexOf("summarise this"));
    expect(warnings).toEqual([]);
  });

  it("truncates oversized state without splitting a character", async () => {
    // The block leaves as a system message. A cut through a surrogate pair is
    // a lone surrogate on the wire, which a provider can refuse the whole
    // request over — so the state a run carries must never be cut that way.
    const filler = "\uD83D\uDE00".repeat(20_000);
    const messages = await toEngineMessages([{ id: "1", role: "user", content: "hi" }], [], {
      note: filler,
    });
    const state = messages[0]?.content;
    expect(typeof state).toBe("string");
    expect(state as string).toContain("[state truncated");
    // Well-formed throughout: a lone surrogate survives neither a UTF-8 round
    // trip nor `isWellFormed`.
    expect((state as string).isWellFormed()).toBe(true);
  });

  it("names an unnamed document from its media type and keeps images after the text", async () => {
    const messages = await toEngineMessages(
      [
        {
          id: "1",
          role: "user",
          content: [
            { type: "document", source: { type: "data", value: Buffer.from("x").toString("base64"), mimeType: "text/markdown" } },
            { type: "text", text: "and this picture" },
            { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } },
          ],
        },
      ],
      [],
    );
    const parts = messages[0]?.content as Array<{ type: string; text?: string }>;
    expect(parts.map((part) => part.type)).toEqual(["text", "text", "image_url"]);
    expect(parts[0]?.text).toContain("document-1.markdown");
  });

  it("reports a document it could not read instead of dropping it silently", async () => {
    const warnings: string[] = [];
    const failing: DocumentExtractor = {
      extract: async () => {
        throw new Error("not a PDF");
      },
    };
    const messages = await map(
      [
        {
          id: "1",
          role: "user",
          content: [
            { type: "text", text: "read it" },
            { type: "document", source: { type: "data", value: "AAAA", mimeType: "application/pdf" }, metadata: { filename: "a.pdf" } },
          ],
        },
      ],
      [],
      undefined,
      { documents: failing, warnings },
    );
    expect(messages[0]?.content).toBe("read it");
    expect(warnings).toEqual(["Could not read a.pdf: not a PDF"]);
  });

  it("puts a non-empty state into the system turn as read-only JSON, and nothing for an empty one", async () => {
    const withState = await toEngineMessages([{ id: "1", role: "user", content: "hi" }], [], { draft: "v1" });
    expect(withState[0]).toMatchObject({ role: "system" });
    expect(withState[0]?.content).toContain("read-only");
    expect(withState[0]?.content).toContain('"draft": "v1"');

    const empty = await toEngineMessages([{ id: "1", role: "user", content: "hi" }], [], {});
    expect(empty).toEqual([{ role: "user", content: "hi" }]);
  });

  it("joins context and state into one system turn", async () => {
    const messages = await toEngineMessages(
      [{ id: "1", role: "user", content: "hi" }],
      [{ description: "Page", value: "/orders" }],
      { count: 2 },
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain("- Page: /orders");
    expect(messages[0]?.content).toContain('"count": 2');
  });
});
