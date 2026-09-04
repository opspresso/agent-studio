import { imageDataUrl } from "@/domain/llm/types";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_SIZE_LABEL,
  SUPPORTED_IMAGE_TYPES,
} from "@/domain/llm/imageLimits";

/** An image staged in a composer or run panel, before the turn is sent. */
export interface Attachment {
  b64: string;
  mimeType: string;
  name: string;
}

/** Widened for the file picker's `accept` and a plain `includes` check. */
export const ACCEPTED_IMAGE_TYPES: readonly string[] = SUPPORTED_IMAGE_TYPES;

/**
 * Read a picked file into an attachment. Rejecting here (rather than on submit)
 * is what lets the composer explain the problem next to the file that caused it.
 */
export async function readAttachment(file: File): Promise<Attachment> {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    throw new Error(`${file.name}: only PNG, JPEG, GIF and WebP images are supported`);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`${file.name}: larger than ${MAX_IMAGE_SIZE_LABEL}`);
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`${file.name}: could not be read`));
    reader.readAsDataURL(file);
  });
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { b64, mimeType: file.type, name: file.name };
}

export function attachmentSrc(attachment: Attachment): string {
  return imageDataUrl(attachment);
}

/** Strip the display-only field: the API takes bytes and a type. */
export function toRequestImages(
  attachments: Attachment[],
): Array<{ b64: string; mimeType: string }> {
  return attachments.map(({ b64, mimeType }) => ({ b64, mimeType }));
}
