import OpenAI from "openai";
import type { ModelProvider } from "@openai/agents";
import { createAgentModelProvider } from "@/infrastructure/llm/agentModels";
import type { LlmChannel, ChannelParams } from "@/domain/llm/channel";

/** Existing wire fixtures run through the real SDK converter and tool runtime. */
export function scriptedModels(channel: LlmChannel): ModelProvider {
  return {
    async getModel(name = "test") {
      const client = new OpenAI({
        apiKey: "unit-test", baseURL: "http://model.test/v1", maxRetries: 0,
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          const params: ChannelParams = {
            model: String(body.model),
            messages: body.messages as ChannelParams["messages"],
            ...(body.tools ? { tools: body.tools as ChannelParams["tools"] } : {}),
            ...(body.temperature !== undefined ? { temperature: Number(body.temperature) } : {}),
            ...(body.presence_penalty !== undefined ? { presencePenalty: Number(body.presence_penalty) } : {}),
            ...(body.max_tokens !== undefined || body.max_completion_tokens !== undefined ? { maxTokens: Number(body.max_tokens ?? body.max_completion_tokens) } : {}),
            ...(body.reasoning_effort ? { reasoningEffort: body.reasoning_effort as ChannelParams["reasoningEffort"] } : {}),
            ...(body.response_format ? { responseFormat: body.response_format as Record<string, unknown> } : {}),
            signal: init?.signal ?? undefined,
          };
          if (!body.stream) return Response.json(await channel.chatCompletion(params));
          const source = channel.chatCompletionStream(params)[Symbol.asyncIterator]();
          const encoder = new TextEncoder();
          let seen = false;
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const next = await source.next();
                if (next.done) {
                  if (!seen) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] })}\n\n`));
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  controller.close();
                  return;
                }
                seen = true;
                const data = next.value;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                  id: "test-response", ...data,
                  choices: data.choices.map((choice, index) => ({ ...choice, index })),
                  ...(data.usage ? { usage: { ...data.usage, cost: data.usage.cost_usd } } : {}),
                })}\n\n`));
              } catch (error) { controller.error(error); }
            },
            async cancel() { await source.return?.(); },
          });
          return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
        },
      });
      const model = await createAgentModelProvider(async () => ({ providerName: null, baseUrl: "http://model.test/v1", apiKey: "test", auth: "bearer", model: name }), () => client).getModel(name);
      return {
        getResponse: model.getResponse.bind(model),
        async *getStreamedResponse(request) {
          for await (const event of model.getStreamedResponse(request)) {
            yield event.type === "response_done" && event.response.output.length === 0
              ? { ...event, response: { ...event.response, output: [{ type: "message" as const, role: "assistant" as const, status: "completed" as const, content: [{ type: "output_text" as const, text: "" }] }] } }
              : event;
          }
        },
      };
    },
  };
}
