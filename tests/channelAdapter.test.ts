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
        auth: "bearer",
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
  runtime.providerBaseUrl = "https://provider.example/v1";
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

  it.each(["chat-run-stopped", new Error("run deadline")])(
    "preserves the caller's abort reason when the SDK ends a partial stream cleanly: %s",
    async (reason) => {
      runtime.providerBaseUrl = "https://cancel-stream.example/v1";
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "Partial reply" }, finish_reason: null }] })}\n\n`,
            ));
            signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }));
      const controller = new AbortController();
      const stream = channel.chatCompletionStream({
        model: "openai/gpt-test",
        messages: [{ role: "user", content: "hello" }],
        signal: controller.signal,
      })[Symbol.asyncIterator]();

      const first = await stream.next();
      expect(first.value?.choices[0]?.delta.content).toBe("Partial reply");
      controller.abort(reason);
      await expect(stream.next()).rejects.toBe(reason);
    },
  );

  /**
   * Two channels answer in dialects of the same protocol, and both of these were
   * observed live: Bedrock's open-weight models put the model's thinking in
   * `reasoning` rather than `reasoning_content` — where a run that reads only
   * the second name shows an empty reply — and OpenRouter appends what the call
   * cost to the usage frame.
   */
  it("reads a dialect's reasoning field and a router's reported cost", async () => {
    runtime.providerBaseUrl = "https://dialect.example/v1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const frames = [
          { choices: [{ delta: { reasoning: "weighing it up" }, finish_reason: null }] },
          { choices: [{ delta: { content: "Answered." }, finish_reason: "stop" }] },
          {
            choices: [],
            usage: {
              prompt_tokens: 5,
              completion_tokens: 2,
              cost: 0.0007,
              completion_tokens_details: { reasoning_tokens: 1 },
            },
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

    expect(chunks[0]?.choices[0]?.delta.reasoning_content).toBe("weighing it up");
    expect(chunks[1]?.choices[0]?.delta.content).toBe("Answered.");
    expect(chunks[2]?.usage?.cost_usd).toBe(0.0007);
    // Inside `completion_tokens`, carried so a reasoning block can say how much
    // of the turn went into thinking — never priced a second time.
    expect(chunks[2]?.usage?.completion_tokens_details?.reasoning_tokens).toBe(1);
  });

  /** A channel that reports no cost must leave the field off, not report $0. */
  it("omits the cost when the channel reports none", async () => {
    runtime.providerBaseUrl = "https://no-cost.example/v1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          model: "gpt-test",
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "hi" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      ),
    );

    const completion = await channel.chatCompletion({
      model: "openai/gpt-test",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(completion.usage).not.toHaveProperty("cost_usd");
  });

  it("never delegates caller-controlled image fetching to the provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      channel.chatCompletion({
        model: "openai/gpt-test",
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "https://internal.example/image.png" } },
            ],
          },
        ],
      }),
    ).rejects.toThrow("LLM image inputs must contain bounded inline image bytes");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
