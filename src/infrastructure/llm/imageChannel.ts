/**
 * OpenAI Images API adapter with the same per-provider dispatch as the text
 * channel: `provider/model` ids route to registered provider channels with the
 * prefix stripped; everything else uses the default channel.
 */

import OpenAI from "openai";
import { config } from "@/lib/config";
import { parseProviderConfigs, resolveProviderTarget } from "./providers";
import type { ProviderChannelConfig, ResolvedTarget } from "./providers";
import type {
  ImageChannel,
  ImageGenerationParams,
  ImageGenerationResult,
} from "@/domain/llm/imageChannel";

let providerConfigs: ProviderChannelConfig[] | undefined;
const clients = new Map<string, OpenAI>();

function resolveTarget(modelId: string): ResolvedTarget {
  providerConfigs ??= parseProviderConfigs(process.env);
  return resolveProviderTarget(modelId, providerConfigs, {
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
  });
}

function getClient(target: ResolvedTarget): OpenAI {
  const key = target.providerName ?? "__default__";
  let client = clients.get(key);
  if (!client) {
    client = new OpenAI({ baseURL: target.baseUrl, apiKey: target.apiKey });
    clients.set(key, client);
  }
  return client;
}

export const imageChannel: ImageChannel = {
  async generateImage(params: ImageGenerationParams): Promise<ImageGenerationResult> {
    const target = resolveTarget(params.model);
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
