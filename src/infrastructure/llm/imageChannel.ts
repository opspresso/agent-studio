/**
 * OpenAI Images API adapter with the same per-provider dispatch as the text
 * channel: `provider/model` ids route to registered provider channels with the
 * prefix stripped; everything else uses the default channel.
 */

import OpenAI, { toFile } from "openai";
import { getLlmChannelConfig, getLlmProviderConfigs } from "@/lib/runtime-settings";
import { resolveProviderTarget } from "./providers";
import type { ResolvedTarget } from "./providers";
import type {
  ImageChannel,
  ImageEditParams,
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

/** The subset of an Images API response this adapter reads. */
interface ImagesApiResponse {
  data?: Array<{ b64_json?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { text_tokens?: number; image_tokens?: number };
  };
}

/** Map an Images API response onto the domain result (shared by generate/edit). */
function toImageResult(response: ImagesApiResponse, what: string): ImageGenerationResult {
  const b64 = response.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error(`Image ${what} returned no image data`);
  }
  const usage = response.usage;
  const textInputTokens = usage?.input_tokens_details?.text_tokens ?? usage?.input_tokens ?? 0;
  return {
    b64,
    mimeType: "image/png",
    usage: {
      textInputTokens,
      imageInputTokens: usage?.input_tokens_details?.image_tokens ?? 0,
      imageOutputTokens: usage?.output_tokens ?? 0,
    },
  };
}

export const imageChannel: ImageChannel = {
  async generateImage(params: ImageGenerationParams): Promise<ImageGenerationResult> {
    const target = await resolveTarget(params.model);
    const response = (await getClient(target).images.generate({
      model: target.model,
      prompt: params.prompt,
      ...(params.size ? { size: params.size as never } : {}),
      ...(params.quality ? { quality: params.quality as never } : {}),
    }, { signal: params.signal })) as unknown as ImagesApiResponse;

    return toImageResult(response, "generation");
  },

  async editImage(params: ImageEditParams): Promise<ImageGenerationResult> {
    const target = await resolveTarget(params.model);
    // The edit endpoint is multipart: the bytes go up as files, not base64 json.
    const files = await Promise.all(
      params.images.map((image, index) =>
        toFile(Buffer.from(image.b64, "base64"), `image-${index + 1}${extensionFor(image.mimeType)}`, {
          type: image.mimeType,
        }),
      ),
    );
    const mask = params.mask
      ? await toFile(Buffer.from(params.mask.b64, "base64"), "mask.png", {
          type: params.mask.mimeType,
        })
      : undefined;
    // One source image goes up as a single file: the older edit models reject an
    // array, and only the composing models accept several.
    const [first] = files;
    const response = (await getClient(target).images.edit({
      model: target.model,
      prompt: params.prompt,
      image: first && files.length === 1 ? first : files,
      ...(mask ? { mask } : {}),
      ...(params.size ? { size: params.size as never } : {}),
      ...(params.quality ? { quality: params.quality as never } : {}),
    }, { signal: params.signal })) as unknown as ImagesApiResponse;

    return toImageResult(response, "edit");
  },
};

/** File extension matching a supported image mime type; providers key on it. */
function extensionFor(mimeType: string): string {
  if (mimeType === "image/jpeg") {
    return ".jpg";
  }
  if (mimeType === "image/webp") {
    return ".webp";
  }
  return ".png";
}
