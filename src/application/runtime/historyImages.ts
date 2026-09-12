import type { AgentInputItem } from "@openai/agents";
import { MAX_IMAGES_PER_TURN, parseImageDataUrl } from "@/domain/llm/imageLimits";

/** Keep the newest bounded inline images, retaining a text marker for each omitted part. */
export function historyImages(items: AgentInputItem[]) {
  const images: Array<{ b64: string; mimeType: string }> = [];
  let dropped = 0;
  const visit = (value: unknown, assistant = false): unknown => {
    if (Array.isArray(value)) return value.toReversed().map((entry) => visit(entry, assistant)).reverse();
    if (!value || typeof value !== "object") return value;
    const entry = value as Record<string, unknown>;
    if (entry.type === "input_image" || entry.type === "image") {
      const image = typeof entry.image === "string" ? parseImageDataUrl(entry.image) : null;
      if (image && images.length < MAX_IMAGES_PER_TURN) {
        images.unshift(image);
        return entry;
      }
      dropped += 1;
      return { type: assistant ? "output_text" : entry.type === "image" ? "text" : "input_text", text: "[An earlier image is no longer available in this run's context.]" };
    }
    return Object.fromEntries(Object.entries(entry).map(([key, nested]) => [key, visit(nested, entry.role === "assistant" || assistant)]));
  };
  return { items: visit(items) as AgentInputItem[], images, dropped };
}
