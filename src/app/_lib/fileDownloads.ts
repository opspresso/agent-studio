import { base64ByteLength, base64Chars, isBase64Payload } from "@/domain/llm/base64";

/** Bound total bytes retained for inline downloads from one raw run without object storage. */
export const MAX_INLINE_FILE_DOWNLOAD_BYTES = 16 * 1024 * 1024;

/** Inline files are downloads; an artifact row is still required for an isolated preview. */
export function createFileDownloads() {
  let retainedBytes = 0;
  return (file: { name: string; url?: string; b64?: string }): { url?: string; warning?: string } => {
    if (file.url) return { url: file.url };
    if (file.b64 === undefined) return {};
    const tooLarge = () => ({ warning: `${file.name}: this run's files exceed the ${MAX_INLINE_FILE_DOWNLOAD_BYTES / (1024 * 1024)} MiB inline download limit, so this file cannot be downloaded.` });
    const available = MAX_INLINE_FILE_DOWNLOAD_BYTES - retainedBytes;
    if (file.b64.length > base64Chars(available)) return tooLarge();
    if (!isBase64Payload(file.b64)) {
      return { warning: `${file.name}: this file has invalid base64 bytes and cannot be downloaded.` };
    }
    const bytes = base64ByteLength(file.b64);
    if (bytes > available) return tooLarge();
    retainedBytes += bytes;
    // A binary MIME type keeps markup from rendering if a download link is opened directly.
    return { url: `data:application/octet-stream;base64,${file.b64}` };
  };
}
