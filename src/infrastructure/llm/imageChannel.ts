/**
 * Images API adapter with the same per-provider dispatch as the text channel:
 * `provider/model` ids route to registered provider channels with the prefix
 * stripped; everything else uses the default channel.
 *
 * Unlike the text channel, the wire protocol here is **not** one shape for
 * everybody. Chat Completions is a de-facto standard every provider implements;
 * the Images API is not, and xAI's differs in every part — different field names
 * for the same intent, a default response format this adapter cannot read, and
 * an edit endpoint that refuses the SDK's multipart entirely. So this is the
 * first reader of `ResolvedTarget.providerName`, which was populated all along
 * and never consulted: the domain port states an *intent* (`size`, `quality` —
 * the vocabulary the tool schema offers the model, which knows no providers) and
 * this module translates it per provider.
 */

import OpenAI, { toFile } from "openai";
import { createLlmClientCache, llmClientCacheKey } from "./clientCache";
import type { ResolvedTarget, TargetResolver } from "./providers";
import {
  base64ByteLength,
  base64Chars,
  MAX_ATTACHMENT_BYTES,
  SUPPORTED_IMAGE_TYPES,
} from "@/domain/llm/imageLimits";
import { imageDataUrl } from "@/domain/llm/types";
import { readBodyText } from "@/shared/httpBody";
import { log } from "@/shared/logger";
import type {
  ImageBytes,
  ImageChannel,
  ImageEditParams,
  ImageGenerationParams,
  ImageGenerationResult,
} from "@/domain/llm/imageChannel";

const clients = createLlmClientCache<OpenAI>();

/** One base64 image plus ample room for usage metadata and provider envelopes. */
export const MAX_IMAGE_API_RESPONSE_BYTES = base64Chars(MAX_ATTACHMENT_BYTES) + 256_000;

/**
 * Keyed by a credential fingerprint so a runtime settings change gets a fresh
 * client without retaining raw keys in the cache index.
 *
 * A SigV4 channel is refused here rather than sent unsigned. The text channel
 * signs a JSON body; this one posts multipart for an edit, which cannot be
 * signed without draining the stream first — and an AWS channel serves no image
 * model this app registers, so the case is a misconfiguration, not a gap. Said
 * plainly, because the alternative is a 403 with nothing pointing at the cause.
 */
function getClient(target: ResolvedTarget): OpenAI {
  if (target.auth === "sigv4") {
    throw new Error(
      `Image channel "${target.providerName ?? "default"}" is configured for SigV4, which the images API does not support`,
    );
  }
  const key = llmClientCacheKey(target.baseUrl, target.apiKey);
  let client = clients.get(key);
  if (!client) {
    client = new OpenAI({ baseURL: target.baseUrl, apiKey: target.apiKey });
    clients.set(key, client);
  }
  return client;
}

/** The subset of an Images API response this adapter reads. */
interface ImagesApiResponse {
  data?: Array<{ b64_json?: string; mime_type?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { text_tokens?: number; image_tokens?: number };
  };
}

function checkedImageBytes(
  b64: string,
  mimeType: string,
  what: string,
): { b64: string; mimeType: string } {
  if (!(SUPPORTED_IMAGE_TYPES as readonly string[]).includes(mimeType)) {
    throw new Error(`Image ${what} returned unsupported image type ${mimeType}`);
  }
  const byteLength = base64ByteLength(b64);
  if (byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Image ${what} returned ${byteLength.toLocaleString("en-US")} bytes, over the ${MAX_ATTACHMENT_BYTES.toLocaleString("en-US")} byte limit`,
    );
  }
  return { b64, mimeType };
}

/**
 * Map an Images API response onto the domain result (shared by generate/edit).
 *
 * The mime type is read rather than assumed. It used to be a hardcoded
 * `image/png`, which held only because OpenAI's default output format is PNG —
 * xAI answers `image/jpeg`, and this value is not cosmetic: it becomes the S3
 * object's extension and `Content-Type` under an immutable cache header, the
 * `data:` prefix on bytes handed back to a *second* model, the Slack upload's
 * filename and the A2A artifact's type. Calling a JPEG a PNG is wrong in all
 * five places at once.
 */
function toImageResult(payload: unknown, what: string): ImageGenerationResult {
  const response = payload as ImagesApiResponse;
  const image = response.data?.[0];
  const b64 = image?.b64_json;
  if (!b64) {
    throw new Error(`Image ${what} returned no image data`);
  }
  const imageBytes = checkedImageBytes(b64, image.mime_type ?? "image/png", what);
  const usage = response.usage;
  const textInputTokens = usage?.input_tokens_details?.text_tokens ?? usage?.input_tokens ?? 0;
  return {
    ...imageBytes,
    usage: {
      // xAI reports no token counts for these models at all — it prices per
      // image and says so as `cost_in_usd_ticks`. Zeros are the honest answer:
      // `calculateImageCost` falls back to the registry's `perImage` when a
      // model has no per-token image rate, which is what actually gets billed.
      textInputTokens,
      imageInputTokens: usage?.input_tokens_details?.image_tokens ?? 0,
      imageOutputTokens: usage?.output_tokens ?? 0,
    },
  };
}

/** The providers whose Images API is not OpenAI's. */
const XAI = "xai";
const OPENROUTER = "openrouter";

/**
 * The tool schema's `size` values, as xAI names the same thing.
 *
 * Not a general parser: the enum the model may answer with is exactly these
 * three (`IMAGE_TOOL_DEF` in the engine), so the map is total over what can
 * arrive. Anything else — a hand-written `predict` request, a future enum entry
 * — resolves to no dimensions rather than a guess, and xAI draws its default.
 * `quality` has no counterpart at all: xAI picks quality by *model*
 * (`grok-imagine-image` vs `-image-quality`), and sending the field is refused
 * exactly like `size` was.
 */
const XAI_ASPECT_RATIO: Record<string, string> = {
  "1024x1024": "1:1",
  "1536x1024": "3:2",
  "1024x1536": "2:3",
};

function xaiDimensions(size?: string): { aspect_ratio?: string; resolution?: string } {
  // Own keys only: `size` reaches here from a request body, and a plain lookup
  // answers `constructor` with a function that JSON drops on the way out —
  // sending a resolution with no aspect ratio instead of neither.
  const aspectRatio = size && Object.hasOwn(XAI_ASPECT_RATIO, size) ? XAI_ASPECT_RATIO[size] : undefined;
  return aspectRatio ? { aspect_ratio: aspectRatio, resolution: "1k" } : {};
}

/**
 * One JSON Images call, for the providers the SDK cannot carry.
 *
 * Hand-rolled rather than routed through the SDK because neither provider's
 * edit can use it — xAI documents `images.edit()` as unsupported, since the SDK
 * sends `multipart/form-data` and the API takes JSON only, and OpenRouter has
 * no `images/edits` path at all. Generation *could* go through the SDK, but
 * then the two halves of one provider's dialect would be written twice in two
 * different styles.
 *
 * The response reader is passed in because only the *transport* is shared: the
 * two answer with different field names for the bytes' type and for every
 * usage figure.
 */
async function jsonImageRequest(
  target: ResolvedTarget,
  path: string,
  body: Record<string, unknown>,
  what: string,
  parse: (payload: unknown, what: string) => ImageGenerationResult,
  signal?: AbortSignal,
): Promise<ImageGenerationResult> {
  const response = await fetch(`${target.baseUrl.replace(/\/$/, "")}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${target.apiKey}`,
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const responseText = await readBodyText(response, MAX_IMAGE_API_RESPONSE_BYTES);
  if (!response.ok) {
    // The SDK's error text is what every other provider's failure reads like in
    // a tool result, so match its shape: status, then whatever the body says.
    throw new Error(
      `${response.status} ${providerErrorMessage(responseText) || response.statusText}`,
    );
  }
  try {
    return parse(JSON.parse(responseText) as unknown, what);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Image ${what} returned invalid JSON`);
    }
    throw error;
  }
}

/**
 * What a failure says, in the two shapes these providers say it in.
 *
 * xAI's models answer `{"code":"400","error":"…"}`. The gateway in front of them
 * answers `{"error":{"code":404,"message":"…"}}`, and that is the one a reader
 * actually meets: it is what a path xAI does not serve — or a model that
 * endpoint does not host — comes back as. Only the string form was read, so the
 * nested one arrived as its own raw JSON, with the single sentence that named
 * the problem buried inside a blob. OpenRouter answers in that same nested
 * shape. Anything else still falls back to the body.
 */
function providerErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string") {
      return parsed.error;
    }
    const nested = (parsed.error as { message?: unknown } | null | undefined)?.message;
    return typeof nested === "string" ? nested : body;
  } catch {
    return body;
  }
}

/** The subset of OpenRouter's Images API response this adapter reads. */
interface OpenRouterImageResponse {
  data?: Array<{ b64_json?: string; media_type?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { image_tokens?: number };
  };
}

/**
 * Map OpenRouter's response onto the domain result.
 *
 * Separate from the OpenAI reader because it agrees with it on nothing but the
 * base64 field. The bytes' type is `media_type`, and reading `mime_type` there
 * finds nothing and falls back to PNG — every model checked through this route
 * answered `image/jpeg`, so that fallback would be wrong every time, in the five
 * places the mime type lands.
 *
 * The usage split is what OpenRouter reports and no more. It states one
 * `prompt_tokens` for the whole prompt, with no text/image division, so a
 * reference image's tokens are counted as text input — that under-prices an
 * edit only on a model whose image input costs more than its text (GPT Image 2:
 * $8 against $5), and inventing the split would be a number nobody published.
 * Image output is `completion_tokens_details.image_tokens`; a model billed per
 * picture reports a synthetic count there and is priced by the registry's flat
 * `perImage` regardless, since it carries no per-token image rate.
 */
function toOpenRouterImageResult(payload: unknown, what: string): ImageGenerationResult {
  const response = payload as OpenRouterImageResponse;
  const image = response.data?.[0];
  const b64 = image?.b64_json;
  if (!b64) {
    throw new Error(`Image ${what} returned no image data`);
  }
  const imageBytes = checkedImageBytes(b64, image.media_type ?? "image/png", what);
  const usage = response.usage;
  const imageOutputTokens =
    usage?.completion_tokens_details?.image_tokens ?? usage?.completion_tokens ?? 0;
  if (imageOutputTokens === 0) {
    // A drawn picture that reports no output tokens is priced at $0 by every
    // model here that bills per token, and the registry cannot tell that from a
    // free call — the unknown-model counter only fires when the *model* is
    // missing. So say it: if these field names ever move, this line is the only
    // thing between a month of drawing and a cost dashboard reading zero.
    log.warn(
      "image",
      `OpenRouter reported no image output tokens for an image ${what}; usage may be under-recorded`,
    );
  }
  return {
    ...imageBytes,
    usage: {
      textInputTokens: usage?.prompt_tokens ?? 0,
      imageInputTokens: 0,
      imageOutputTokens,
    },
  };
}

/**
 * What OpenRouter is told about the picture's shape — which is the size and
 * never the quality.
 *
 * `size` is the one field the router normalises for whoever serves the model:
 * a pixel pair reaches Gemini, GPT Image and the two Grok models alike, and the
 * price does not move with it.
 *
 * `quality` it passes straight through to a provider that may not take it, and
 * a router in front of many vendors cannot make one vocabulary out of that:
 * Gemini ignores the field, GPT Image honours OpenAI's four values, and Grok
 * answers `400 … quality: not supported. Accepted: low, medium` to the "high"
 * the tool schema lets a model ask for. There is no value that is safe on all
 * four, so none is sent and each provider draws at its default — which is the
 * tier the registry's `perImage` is priced at. The vendor-direct route keeps
 * its own answer to the same question.
 */
function openRouterDimensions(size?: string): Record<string, unknown> {
  return size ? { size } : {};
}

/**
 * The reference images of an OpenRouter edit.
 *
 * There is no edit *endpoint* here: the same `/images` call takes the sources
 * as `input_references`, which is why an edit and a generation differ by one
 * field rather than by a path.
 */
function openRouterReferences(images: ImageBytes[]): Record<string, unknown> {
  return {
    input_references: images.map((image) => ({
      type: "image_url",
      image_url: { url: imageDataUrl(image) },
    })),
  };
}

/** The source image(s) of an xAI edit: one `image`, or `images` for several. */
function xaiEditSources(images: ImageBytes[]): Record<string, unknown> {
  const refs = images.map((image) => ({ url: imageDataUrl(image) }));
  const [first] = refs;
  // The two fields are mutually exclusive in xAI's schema, and multi-reference
  // editing is a different feature from editing one picture.
  return first && refs.length === 1 ? { image: first } : { images: refs };
}

/** The target resolver is injected; see `createChannel`. */
export function createImageChannel(resolveTarget: TargetResolver): ImageChannel {
  return {
    async generateImage(params: ImageGenerationParams): Promise<ImageGenerationResult> {
      const target = await resolveTarget(params.model);
      if (target.providerName === XAI) {
        return jsonImageRequest(
          target,
          "images/generations",
          {
            model: target.model,
            prompt: params.prompt,
            ...xaiDimensions(params.size),
            // xAI defaults to `url`, and this adapter has to return bytes.
            response_format: "b64_json",
          },
          "generation",
          toImageResult,
          params.signal,
        );
      }
      if (target.providerName === OPENROUTER) {
        return jsonImageRequest(
          target,
          // Not `images/generations`: OpenRouter serves one image path, and the
          // OpenAI one 404s.
          "images",
          {
            model: target.model,
            prompt: params.prompt,
            ...openRouterDimensions(params.size),
          },
          "generation",
          toOpenRouterImageResult,
          params.signal,
        );
      }
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
      if (target.providerName === XAI) {
        if (params.mask) {
          // Refused rather than dropped: a mask says *where* to edit, so
          // ignoring it would silently redraw the whole picture and report
          // success. xAI's schema has no counterpart.
          throw new Error("Image edit masks are not supported by this provider");
        }
        return jsonImageRequest(
          target,
          "images/edits",
          {
            model: target.model,
            prompt: params.prompt,
            ...xaiEditSources(params.images),
            ...xaiDimensions(params.size),
            response_format: "b64_json",
          },
          "edit",
          toImageResult,
          params.signal,
        );
      }
      if (target.providerName === OPENROUTER) {
        if (params.mask) {
          // Same refusal as xAI's, for the same reason: OpenRouter's image
          // request has no mask field, and dropping one would redraw the whole
          // picture and call it a success.
          throw new Error("Image edit masks are not supported by this provider");
        }
        return jsonImageRequest(
          target,
          "images",
          {
            model: target.model,
            prompt: params.prompt,
            ...openRouterReferences(params.images),
            ...openRouterDimensions(params.size),
          },
          "edit",
          toOpenRouterImageResult,
          params.signal,
        );
      }
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
}

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
