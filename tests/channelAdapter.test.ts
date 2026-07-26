import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ providerBaseUrl: "https://provider.example/v1" }));

import { createChannel } from "@/infrastructure/llm/channel";
import { resolveProviderTarget } from "@/infrastructure/llm/providers";

// The resolver is injected now: settings resolution belongs to the composition
// root, so this test supplies it directly instead of mocking runtime-settings.
const channel = createChannel(async (modelId) =>
  resolveProviderTarget(
    modelId,
    [
      {
        name: "openai",
        baseUrl: runtime.providerBaseUrl,
        apiKey: "provider-key",
        keepModelPrefix: false,
      },
    ],
    { baseUrl: "https://router.example/v1", apiKey: "router-key" },
  ),
);

async function requestBody(input: string | URL | Request, init?: RequestInit): Promise<unknown> {
  const raw =
    typeof init?.body === "string"
      ? init.body
      : input instanceof Request
        ? await input.clone().text()
        : "";
  return JSON.parse(raw);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI channel adapter", () => {
  it("routes provider models and translates request and response fields", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        body = (await requestBody(input, init)) as Record<string, unknown>;
        return Response.json({
          model: "gpt-test",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                reasoning_content: "thinking",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "search", arguments: "{\"q\":\"x\"}" },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 3,
            prompt_tokens_details: { cached_tokens: 4 },
          },
        });
      }),
    );

    const result = await channel.chatCompletion({
      model: "openai/gpt-test",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 50,
      reasoningEffort: "high",
      responseFormat: { type: "json_object" },
    });

    expect(body).toMatchObject({
      model: "gpt-test",
      max_completion_tokens: 50,
      reasoning_effort: "high",
      response_format: { type: "json_object" },
      stream: false,
    });
    expect(result).toMatchObject({
      model: "gpt-test",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            reasoning_content: "thinking",
            tool_calls: [{ id: "call_1", function: { name: "search" } }],
          },
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    });
  });

  it("maps fragmented stream deltas and the usage-only final chunk", async () => {
    runtime.providerBaseUrl = "https://stream-provider.example/v1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const frames = [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: "search", arguments: "{\"q\":" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: "\"x\"}" } }],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
          {
            choices: [],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          },
        ];
        const body = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }),
    );

    const chunks = [];
    for await (const chunk of channel.chatCompletionStream({
      model: "openai/gpt-test",
      messages: [{ role: "user", content: "hello" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.choices[0]?.delta.tool_calls?.[0]).toMatchObject({
      id: "call_1",
      function: { name: "search", arguments: "{\"q\":" },
    });
    expect(chunks[1]?.choices[0]?.delta.tool_calls?.[0]).toMatchObject({
      function: { arguments: "\"x\"}" },
    });
    expect(chunks[2]?.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 2 });
  });
});
