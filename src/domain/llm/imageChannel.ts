/**
 * Image generation channel port.
 *
 * The vocabulary below is OpenAI's, and deliberately so: it is what the tool
 * schema offers the model, and a model knows nothing about which provider will
 * serve its request. It states an *intent*, not a wire format — the adapter
 * translates per provider, because unlike Chat Completions the Images API is
 * not one shape everybody implements (xAI names the same intent
 * `aspect_ratio` + `resolution` and refuses these field names outright).
 */

export interface ImageGenerationParams {
  model: string;
  prompt: string;
  signal?: AbortSignal;
  /** e.g. "1024x1024", "1536x1024", "1024x1536", "auto" */
  size?: string;
  /** e.g. "low" | "medium" | "high" | "auto" — a provider without a counterpart drops it. */
  quality?: string;
}

/** Bytes of one image, as they travel inside the app. */
export interface ImageBytes {
  b64: string;
  mimeType: string;
}

/** Edit an existing image. Same intent-not-wire-format rule as above. */
export interface ImageEditParams {
  model: string;
  prompt: string;
  /** Source images; a provider that composes takes more than one. */
  images: ImageBytes[];
  /** Optional mask marking the region to change (transparent = edit here). */
  mask?: ImageBytes;
  signal?: AbortSignal;
  size?: string;
  quality?: string;
}

export interface ImageGenerationUsage {
  textInputTokens: number;
  imageInputTokens: number;
  imageOutputTokens: number;
}

export interface ImageGenerationResult {
  /** Base64-encoded image bytes. */
  b64: string;
  mimeType: string;
  usage: ImageGenerationUsage;
}

export interface ImageChannel {
  generateImage(params: ImageGenerationParams): Promise<ImageGenerationResult>;
  editImage(params: ImageEditParams): Promise<ImageGenerationResult>;
}
