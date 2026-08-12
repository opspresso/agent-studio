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
import type { ResolvedTarget, TargetResolver } from "./providers";
import { imageDataUrl } from "@/domain/llm/types";
import type {
  ImageBytes,
  ImageChannel,
  ImageEditParams,
  ImageGenerationParams,
  ImageGenerationResult,
} from "@/domain/llm/imageChannel";

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

/** The subset of an Images API response this adapter reads. */
interface ImagesApiResponse {
  data?: Array<{ b64_json?: string; mime_type?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { text_tokens?: number; image_tokens?: number };
  };
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
function toImageResult(response: ImagesApiResponse, what: string): ImageGenerationResult {
  const image = response.data?.[0];
  const b64 = image?.b64_json;
  if (!b64) {
    throw new Error(`Image ${what} returned no image data`);
  }
  const usage = response.usage;
  const textInputTokens = usage?.input_tokens_details?.text_tokens ?? usage?.input_tokens ?? 0;
  return {
    b64,
    mimeType: image.mime_type ?? "image/png",
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

/** The provider whose Images API is not OpenAI's. */
const XAI = "xai";

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
  const aspectRatio = size ? XAI_ASPECT_RATIO[size] : undefined;
  return aspectRatio ? { aspect_ratio: aspectRatio, resolution: "1k" } : {};
}

/**
 * One xAI Images call.
 *
 * Hand-rolled rather than routed through the SDK because the edit endpoint
 * cannot use it — xAI documents `images.edit()` as unsupported, since the SDK
 * sends `multipart/form-data` and the API takes JSON only. Generation *could*
 * go through the SDK, but then the two halves of one provider's dialect would
 * be written twice in two different styles.
 *
 * `response_format` is always explicit: xAI defaults to `url`, and this adapter
 * has to return bytes.
 */
async function xaiImageRequest(
  target: ResolvedTarget,
  path: string,
  body: Record<string, unknown>,
  what: string,
  signal?: AbortSignal,
): Promise<ImageGenerationResult> {
  const response = await fetch(`${target.baseUrl.replace(/\/$/, "")}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${target.apiKey}`,
    },
    body: JSON.stringify({ ...body, response_format: "b64_json" }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    // The SDK's error text is what every other provider's failure reads like in
    // a tool result, so match its shape: status, then whatever the body says.
    const detail = await response.text().catch(() => "");
    throw new Error(`${response.status} ${xaiErrorMessage(detail) || response.statusText}`);
  }
  return toImageResult((await response.json()) as ImagesApiResponse, what);
}

/**
 * What an xAI failure says, in the two shapes xAI says it in.
 *
 * The models answer `{"code":"400","error":"…"}`. The gateway in front of them
 * answers `{"error":{"code":404,"message":"…"}}`, and that is the one a reader
 * actually meets: it is what a path xAI does not serve — or a model that
 * endpoint does not host — comes back as. Only the string form was read, so the
 * nested one arrived as its own raw JSON, with the single sentence that named
 * the problem buried inside a blob. Anything else still falls back to the body.
 */
function xaiErrorMessage(body: string): string {
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
        return xaiImageRequest(
          target,
          "images/generations",
          {
            model: target.model,
            prompt: params.prompt,
            ...xaiDimensions(params.size),
          },
          "generation",
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
        return xaiImageRequest(
          target,
          "images/edits",
          {
            model: target.model,
            prompt: params.prompt,
            ...xaiEditSources(params.images),
            ...xaiDimensions(params.size),
          },
          "edit",
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
