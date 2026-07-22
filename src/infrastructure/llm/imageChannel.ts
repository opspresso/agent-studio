/**
 * OpenAI Images API adapter with the same per-provider dispatch as the text
 * channel: `provider/model` ids route to registered provider channels with the
 * prefix stripped; everything else uses the default channel.
 */

import OpenAI from "openai";
import { getLlmChannelConfig, getLlmProviderConfigs } from "@/lib/runtime-settings";
import { resolveProviderTarget } from "./providers";
import type { ResolvedTarget } from "./providers";
import type {
  ImageChannel,
  ImageGenerationParams,
  ImageGenerationResult,
} from "@/domain/llm/imageChannel";

const clients = new Map<string, OpenAI>();

async function resolveTarget(modelId: string): Promise<ResolvedTarget> {
  const [providers, defaultChannel] = await Promise.all([
    getLlmProviderConfigs(),
    getLlmChannelConfig(),
  ]);
  return resolveProviderTarget(modelId, providers, defaultChannel);
}

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

export const imageChannel: ImageChannel = {
  async generateImage(params: ImageGenerationParams): Promise<ImageGenerationResult> {
    const target = await resolveTarget(params.model);
    const response = (await getClient(target).images.generate({
      model: target.model,
      prompt: params.prompt,
      ...(params.size ? { size: params.size as never } : {}),
      ...(params.quality ? { quality: params.quality as never } : {}),
    })) as unknown as {
      data?: Array<{ b64_json?: string }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { text_tokens?: number; image_tokens?: number };
      };
    };

    const b64 = response.data?.[0]?.b64_json;
    if (!b64) {
      throw new Error("Image generation returned no image data");
    }
    const usage = response.usage;
    const textInputTokens =
      usage?.input_tokens_details?.text_tokens ?? usage?.input_tokens ?? 0;
    return {
      b64,
      mimeType: "image/png",
      usage: {
        textInputTokens,
        imageInputTokens: usage?.input_tokens_details?.image_tokens ?? 0,
        imageOutputTokens: usage?.output_tokens ?? 0,
      },
    };
  },
};
