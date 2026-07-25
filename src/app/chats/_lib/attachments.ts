import type { Attachment } from "./types";

/** Mirrors the server caps in `src/app/api/chats/_lib/schemas.ts`. */
export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * Read a picked file into an attachment. Rejecting here (rather than on submit)
 * is what lets the composer explain the problem next to the file that caused it.
 */
export async function readAttachment(file: File): Promise<Attachment> {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    throw new Error(`${file.name}: only PNG, JPEG, GIF and WebP images are supported`);
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${file.name}: larger than 5MB`);
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
  return `data:${attachment.mimeType};base64,${attachment.b64}`;
}

/** Strip the display-only field: the API takes bytes and a type. */
export function toRequestImages(
  attachments: Attachment[],
): Array<{ b64: string; mimeType: string }> {
  return attachments.map(({ b64, mimeType }) => ({ b64, mimeType }));
}
