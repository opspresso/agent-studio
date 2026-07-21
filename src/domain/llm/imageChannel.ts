/** Image generation channel port (OpenAI Images API shape). */

export interface ImageGenerationParams {
  model: string;
  prompt: string;
  /** e.g. "1024x1024", "1536x1024", "1024x1536", "auto" */
  size?: string;
  /** e.g. "low" | "medium" | "high" | "auto" */
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
}
