/**
 * Port for turning an attached document into the text a turn carries.
 *
 * Text rather than provider-native file parts, and that is a decision about this
 * deployment rather than a simplification. A model id here may be served by the
 * default router or by its own provider's OpenAI-compatible endpoint
 * (`LLM_PROVIDER_<NAME>_BASE_URL`), and those disagree about how — or whether —
 * a file part may be sent. The registry models capability per *model*
 * (`ModelCapabilities`), which cannot express a difference that belongs to the
 * channel, and sending a part the endpoint rejects fails the whole turn. Text
 * costs a capability gate nothing: it works on every channel, survives chat
 * persistence and replay unchanged, and is masked by the PII filter like any
 * other text.
 *
 * Extraction is behind a port because it needs a PDF parser, which is a library
 * and therefore infrastructure.
 */

/** A document read successfully. `text` may be empty only if the file was. */
import { documentKind } from "./documentLimits";

export interface ExtractedDocument {
  text: string;
  /**
   * What came back, in the document's own units, when not all of it did — "the
   * first 12 of 40 pages". A fact a model can act on; a silently short answer is
   * not.
   */
  note?: string;
}

/**
 * The document could not be read, with a reason meant for the person who
 * attached it: password-protected, not a valid PDF, a scan with no text layer.
 *
 * A separate type because the alternative is returning empty text, and "the
 * document is empty" is a different and far more damaging answer than "I could
 * not read it".
 */
export class DocumentExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentExtractionError";
  }
}

export interface DocumentExtractor {
  /**
   * @param maxChars Stop at this many characters and say so in `note`. Passed in
   * rather than read here so the caller's per-turn budget, which shrinks as
   * earlier documents spend it, is the one that applies.
   * @throws {DocumentExtractionError} when the file yields no usable text.
   */
  extract(input: {
    bytes: Uint8Array;
    mimeType: string;
    name: string;
    maxChars: number;
    /**
     * The encoding the source declared, when something said so — an HTTP header
     * on a fetched page. Absent for an upload, which is the difference that
     * matters: a person whose file is not UTF-8 can go and re-save it, and is
     * told to, while a remote server is not something the caller can fix.
     */
    charset?: string;
  }): Promise<ExtractedDocument>;
}

/** A parser supplied by an optional office-document capability. */
export type OfficeDocumentReader = (input: {
  bytes: Uint8Array;
  mimeType: string;
  name: string;
}) => Promise<string>;

function cutText(text: string, maxChars: number): ExtractedDocument {
  const points = Array.from(text);
  if (points.length <= maxChars) {
    return { text };
  }
  return {
    text: points.slice(0, maxChars).join(""),
    note: `the first ${maxChars.toLocaleString("en-US")} of ${points.length.toLocaleString("en-US")} characters`,
  };
}

/** Add an optional office parser without changing the local PDF/text adapter. */
export function withOfficeDocumentReader(
  fallback: DocumentExtractor,
  reader: OfficeDocumentReader | undefined,
  unavailableReason = "no office-document reader is available",
): DocumentExtractor {
  return {
    async extract(input) {
      if (documentKind(input.mimeType, input.name) !== "office") {
        return fallback.extract(input);
      }
      if (!reader) {
        throw new DocumentExtractionError(unavailableReason);
      }
      if (input.maxChars <= 0) {
        throw new DocumentExtractionError("this turn's document budget is already spent");
      }
      return cutText(await reader(input), input.maxChars);
    },
  };
}
