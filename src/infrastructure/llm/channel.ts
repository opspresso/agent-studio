/**
 * OpenAI-compatible LLM channel with per-provider dispatch. Model ids in
 * `provider/model` form route to provider channels resolved from runtime
 * settings (DB override, else `LLM_PROVIDER_<PROVIDER>_BASE_URL` / `_API_KEY`
 * env); everything else goes to the default channel. The wire protocol is
 * always OpenAI Chat
 * Completions — the SDK shapes are mapped onto the domain port so the engine
 * stays SDK-agnostic.
 */

import OpenAI from "openai";
import type { ResolvedTarget, TargetResolver } from "./providers";
import type {
  ChannelChunk,
  ChannelCompletion,
  ChannelParams,
  ChannelToolCall,
  ChannelUsage,
  LlmChannel,
} from "@/domain/llm/channel";

const clients = new Map<string, OpenAI>();

/** Keyed by baseUrl|apiKey so a runtime settings change gets a fresh client. */
function getClient(target: ResolvedTarget): OpenAI {
  const key = `${target.baseUrl}|${target.apiKey}`;
  let client = clients.get(key);
  if (!client) {
    client = new OpenAI({ baseURL: target.baseUrl, apiKey: target.apiKey });
    clients.set(key, client);
  }
  return client;
}

/** Translate domain params into an OpenAI Chat Completions request body. */
function toRequestBody(params: ChannelParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
  };
  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools;
  }
  if (params.temperature !== undefined) {
    body.temperature = params.temperature;
  }
  if (params.maxTokens !== undefined) {
    body.max_completion_tokens = params.maxTokens;
  }
  if (params.reasoningEffort !== undefined) {
    body.reasoning_effort = params.reasoningEffort;
  }
  if (params.responseFormat !== undefined) {
    body.response_format = params.responseFormat;
  }
  return body;
}

function toChannelUsage(usage: unknown): ChannelUsage | null {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const u = usage as {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
  };
  return {
    prompt_tokens: u.prompt_tokens ?? 0,
    completion_tokens: u.completion_tokens ?? 0,
    prompt_tokens_details: u.prompt_tokens_details ?? null,
  };
}

function toChannelToolCalls(toolCalls: unknown): ChannelToolCall[] | undefined {
  if (!Array.isArray(toolCalls)) {
    return undefined;
  }
  return toolCalls.map((tc) => {
    const call = tc as {
      index?: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    };
    return {
      index: call.index,
      id: call.id,
      type: call.type,
      function: call.function
        ? { name: call.function.name, arguments: call.function.arguments }
        : undefined,
    };
  });
}

/**
 * The target resolver is injected: reading runtime settings is the composition
 * root's job, so this adapter never reaches up into `lib/`. It is called per
 * request, so a settings change still takes effect on the next TTL refresh.
 */
export function createChannel(resolveTarget: TargetResolver): LlmChannel {
  return {
    async chatCompletion(params: ChannelParams): Promise<ChannelCompletion> {
      const target = await resolveTarget(params.model);
      const response = (await getClient(target).chat.completions.create({
        ...(toRequestBody({ ...params, model: target.model }) as { model: string; messages: [] }),
        stream: false,
      }, { signal: params.signal })) as unknown as {
        model?: string;
        choices?: Array<{
          finish_reason?: string | null;
          message?: {
            role?: string;
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: unknown;
          };
        }>;
        usage?: unknown;
      };

      return {
        model: response.model,
        usage: toChannelUsage(response.usage),
        choices: (response.choices ?? []).map((choice) => ({
          finish_reason: choice.finish_reason ?? null,
          message: {
            role: choice.message?.role ?? "assistant",
            content: choice.message?.content ?? null,
            reasoning_content: choice.message?.reasoning_content ?? null,
            tool_calls: toChannelToolCalls(choice.message?.tool_calls),
          },
        })),
      };
    },

    async *chatCompletionStream(params: ChannelParams): AsyncGenerator<ChannelChunk> {
      const target = await resolveTarget(params.model);
      const stream = (await getClient(target).chat.completions.create({
        ...(toRequestBody({ ...params, model: target.model }) as { model: string; messages: [] }),
        stream: true,
        stream_options: { include_usage: true },
      }, { signal: params.signal })) as unknown as AsyncIterable<{
        choices?: Array<{
          finish_reason?: string | null;
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: unknown;
          };
        }>;
        usage?: unknown;
      }>;

      for await (const chunk of stream) {
        yield {
          usage: toChannelUsage(chunk.usage),
          choices: (chunk.choices ?? []).map((choice) => ({
            finish_reason: choice.finish_reason ?? null,
            delta: {
              content: choice.delta?.content ?? null,
              reasoning_content: choice.delta?.reasoning_content ?? null,
              tool_calls: toChannelToolCalls(choice.delta?.tool_calls),
            },
          })),
        };
      }
    },
  };
}
