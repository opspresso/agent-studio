import { describe, expect, it } from "vitest";
import { toEngineMessages } from "@/application/agui/input";

describe("toEngineMessages", () => {
  it("maps every protocol role onto the engine's shapes", () => {
    expect(
      toEngineMessages(
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

  it("turns a user turn's parts into text and data-url image parts", () => {
    expect(
      toEngineMessages(
        [
          {
            id: "1",
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image", source: { type: "data", value: "AAAA", mimeType: "image/png" } },
              { type: "image", source: { type: "url", value: "https://example.com/a.png" } },
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
          { type: "image_url", image_url: { url: "https://example.com/a.png" } },
        ],
      },
    ]);
  });

  it("puts the application's context ahead of the history as one system turn", () => {
    expect(
      toEngineMessages(
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
  it("puts a reasoning message back on the assistant turn that follows it", () => {
    expect(
      toEngineMessages(
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
