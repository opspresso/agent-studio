/** Image generation channel port (OpenAI Images API shape). */

export interface ImageGenerationParams {
  model: string;
  prompt: string;
  signal?: AbortSignal;
  /** e.g. "1024x1024", "1536x1024", "1024x1536", "auto" */
  size?: string;
  /** e.g. "low" | "medium" | "high" | "auto" */
  quality?: string;
}

/** Bytes of one image, as they travel inside the app. */
export interface ImageBytes {
  b64: string;
  mimeType: string;
}

/** Edit an existing image (OpenAI Images edit API shape). */
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
