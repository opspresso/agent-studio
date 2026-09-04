/**
 * OpenAI-compatible LLM channel with per-provider dispatch. Model ids in
 * `provider/model` form route to provider channels resolved from runtime
 * settings (DB override, else `LLM_PROVIDER_<PROVIDER>_BASE_URL` / `_API_KEY`
 * env); everything else goes to the default channel. The wire protocol is
 * always OpenAI Chat
 * Completions — the SDK shapes are mapped onto the domain port so the engine
 * stays SDK-agnostic.
 *
 * A channel authenticates one of two ways, and only the transport differs: a
 * bearer key, or AWS SigV4 (`awsSigner.ts`) for the endpoints AWS serves in
 * this same protocol.
 */

import OpenAI from "openai";
import { AWS_SIGNING_SERVICE, createSignedFetch } from "./awsSigner";
import { createLlmClientCache, llmClientCacheKey } from "./clientCache";
import type { ResolvedTarget, TargetResolver } from "./providers";
import type {
  ChannelChunk,
  ChannelCompletion,
  ChannelParams,
  ChannelToolCall,
  ChannelUsage,
  LlmChannel,
} from "@/domain/llm/channel";
import { isInlineImageDataUrl } from "@/domain/llm/imageLimits";

const clients = createLlmClientCache<OpenAI>();

/**
 * Keyed by a credential fingerprint so a runtime settings change gets a fresh
 * client without retaining raw keys in the cache index.
 *
 * A `sigv4` target carries no key, so its per-request credential is the signing
 * `fetch` rather than anything in the constructor — the SDK still wants an
 * `apiKey`, and the placeholder below never reaches the wire because the signer
 * rewrites the headers.
 */
function getClient(target: ResolvedTarget): OpenAI {
  const key = llmClientCacheKey(target.baseUrl, target.auth, target.apiKey);
  let client = clients.get(key);
  if (!client) {
    client = target.auth === "sigv4"
      ? new OpenAI({
          baseURL: target.baseUrl,
          apiKey: "sigv4",
          fetch: createSignedFetch(AWS_SIGNING_SERVICE),
        })
      : new OpenAI({ baseURL: target.baseUrl, apiKey: target.apiKey });
    clients.set(key, client);
  }
  return client;
}

/** Translate domain params into an OpenAI Chat Completions request body. */
function toRequestBody(params: ChannelParams): Record<string, unknown> {
  for (const message of params.messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (part.type === "image_url" && !isInlineImageDataUrl(part.image_url.url)) {
        throw new Error("LLM image inputs must contain bounded inline image bytes");
      }
    }
  }
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
    completion_tokens_details?: { reasoning_tokens?: number } | null;
    cost?: number;
  };
  return {
    prompt_tokens: u.prompt_tokens ?? 0,
    completion_tokens: u.completion_tokens ?? 0,
    prompt_tokens_details: u.prompt_tokens_details ?? null,
    completion_tokens_details: u.completion_tokens_details ?? null,
    // OpenRouter reports what the call cost in `usage.cost`, in USD. Carried
    // only when it is a usable number: a channel that does not report it leaves
    // the field off entirely, which is what makes registry pricing the fallback
    // rather than a $0 that reads like a free call.
    ...(typeof u.cost === "number" && Number.isFinite(u.cost) ? { cost_usd: u.cost } : {}),
  };
}

/**
 * The model's thinking, under whichever name the channel gave it.
 *
 * `reasoning_content` is the spelling this app was built against, and Bedrock's
 * open-weight models answer with `reasoning` instead — same field, and a run
 * that reads only the first name shows an empty reply while the tokens are
 * billed, because on those models the whole answer can arrive as reasoning.
 */
function toReasoning(
  part: { reasoning_content?: string | null; reasoning?: string | null } | undefined,
): string | null {
  return part?.reasoning_content ?? part?.reasoning ?? null;
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
            reasoning?: string | null;
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
            reasoning_content: toReasoning(choice.message),
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
            reasoning?: string | null;
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
              reasoning_content: toReasoning(choice.delta),
              tool_calls: toChannelToolCalls(choice.delta?.tool_calls),
            },
          })),
        };
      }
    },
  };
}
