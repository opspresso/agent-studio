/**
 * Non-image attachments become bounded text for all registered model channels.
 * Provider-native file formats are not part of the model contract. The injected
 * extractor owns parsing; extracted text follows normal PII and Session rules.
 */

/** A document read successfully. `text` may be empty only if the file was. */
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
    signal?: AbortSignal;
  }): Promise<ExtractedDocument>;
}
