/**
 * Turning an address into something a model can read.
 *
 * Runs on two ports and nothing else — the HTTP boundary and the document
 * extractor — so it tests with no network and no parser. Notably it has **no
 * extraction of its own**: text, HTML and PDF all go through the same extractor
 * an attachment does, which is what keeps one owner for "these bytes become this
 * text" rather than a second copy behind the URL tool.
 */

import type { DocumentExtractor } from "@/domain/llm/documentExtractor";
import { DocumentExtractionError } from "@/domain/llm/documentExtractor";
import { documentKind } from "@/domain/llm/documentLimits";
import { MAX_ATTACHMENT_BYTES, SUPPORTED_IMAGE_TYPES } from "@/domain/llm/imageLimits";
import type { HttpResourceReader } from "@/domain/net/httpResource";
import { HttpResourceError } from "@/domain/net/httpResource";

/**
 * How much this pulls from a stranger's server.
 *
 * Our cap, beside the mechanism that spends it. Deliberately *not*
 * `MAX_DOCUMENT_BYTES`: that value also derives the HTTP request-body cap in
 * `src/app/api/_lib/body.ts`, and the two answer different questions — one is
 * "how much may a person upload in one request", this is "how much may a run
 * pull into this process while other runs are doing the same".
 */
export const MAX_FETCH_BYTES = 5 * 1024 * 1024;

/**
 * How much of the text is kept.
 *
 * Far above the attachment cap on purpose — `documentLimits.ts` says why: an
 * attachment is inlined into a turn and stored as one DynamoDB item, while this
 * is a transient tool result. Matched to what the `mcp-url-fetch` server
 * returned, so replacing it is a replacement rather than a downgrade.
 *
 * Cut here rather than left to the per-turn tool-result budget above it: that
 * one truncates with a generic marker, which would replace the note saying
 * "the first 12 of 40 pages" with one saying nothing.
 */
export const MAX_FETCHED_TEXT_CHARS = 90_000;

/** The types worth asking for, in the order they are worth having. */
const ACCEPT =
  "text/html,application/xhtml+xml,text/plain,text/markdown,text/csv,application/pdf,application/json,image/png,image/jpeg,image/webp,image/gif;q=0.9,*/*;q=0.1";

export interface UrlContentPorts {
  http: HttpResourceReader;
  documents: DocumentExtractor;
}

export interface FetchedUrl {
  /** What the model reads. Empty only when an image came back instead. */
  text: string;
  /** What was left out, in the document's own units. */
  note?: string;
  /** Present when the address was a picture. */
  image?: { b64: string; mimeType: string };
}

/**
 * A filename for the extractor to fall back on.
 *
 * It decides on the declared type first and the name second, and plenty of
 * servers label a PDF `application/octet-stream`. The last path segment is what
 * a browser would call the file.
 */
function nameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)) || "index";
  } catch {
    return "index";
  }
}

/**
 * Read an address.
 *
 * Throws {@link HttpResourceError} with a sentence fit to hand a model — the
 * adapter has already stripped anything that would describe the network.
 */
export async function readUrlContent(
  ports: UrlContentPorts,
  url: string,
): Promise<FetchedUrl> {
  const resource = await ports.http.read({
    url,
    accept: ACCEPT,
    maxBytes: MAX_FETCH_BYTES,
  });

  if (resource.mimeType.startsWith("image/")) {
    // The provider's caps, not ours — the same ones an attached image faces,
    // because this picture ends up in the same place by the same route.
    if (!SUPPORTED_IMAGE_TYPES.includes(resource.mimeType as never)) {
      throw new HttpResourceError(
        `that is a ${resource.mimeType} image, which cannot be read here`,
      );
    }
    if (resource.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new HttpResourceError(
        `that image is larger than the ${MAX_ATTACHMENT_BYTES.toLocaleString("en-US")} byte limit`,
      );
    }
    return {
      text: "",
      image: {
        b64: Buffer.from(resource.bytes).toString("base64"),
        mimeType: resource.mimeType,
      },
    };
  }

  const name = nameFromUrl(resource.finalUrl);
  if (documentKind(resource.mimeType, name) === null) {
    throw new HttpResourceError(
      `${resource.mimeType || "that address"} is not something that can be read as text or an image`,
    );
  }

  try {
    const extracted = await ports.documents.extract({
      bytes: resource.bytes,
      mimeType: resource.mimeType,
      name,
      maxChars: MAX_FETCHED_TEXT_CHARS,
      // Only a fetch declares one, which is what keeps the attachment path
      // byte-for-byte as it was.
      ...(resource.charset ? { charset: resource.charset } : {}),
    });
    return { text: extracted.text, ...(extracted.note ? { note: extracted.note } : {}) };
  } catch (error) {
    if (error instanceof DocumentExtractionError) {
      // The extractor's messages are already written for a person ("it is
      // password-protected, so its text cannot be read").
      throw new HttpResourceError(error.message);
    }
    throw error;
  }
}
