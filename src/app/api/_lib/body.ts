import { BodyTooLargeError, readBodyText } from "@/shared/httpBody";
import { base64Chars } from "@/domain/llm/imageLimits";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "@/domain/llm/imageLimits";
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENTS } from "@/domain/llm/documentLimits";

/**
 * Ceiling on a turn body that carries attachments.
 *
 * Derived rather than picked, so it cannot drift from the caps it protects: the
 * most a legitimate request can hold is every attachment at its own limit, plus
 * room for the prose around them. Documents raised this a great deal — four
 * 10MB files are ~56MB of base64 on their own — and the cost of *not* bounding
 * it is paid before any schema runs: `request.json()` materialises the whole
 * body as a UTF-16 string and `JSON.parse` allocates the base64 again, so an
 * unbounded body is several hundred megabytes of resident memory per request,
 * from any signed-in caller, before a single validator has looked at it. The run
 * bracket's concurrency guard opens later and cannot throttle it.
 */
const ATTACHMENT_ALLOWANCE =
  base64Chars(MAX_DOCUMENT_BYTES) * MAX_DOCUMENTS +
  base64Chars(MAX_ATTACHMENT_BYTES) * MAX_ATTACHMENTS;
/** JSON quoting, field names, and the message itself. */
const PROSE_ALLOWANCE = 256 * 1024;

export const MAX_TURN_BODY_BYTES = ATTACHMENT_ALLOWANCE + PROSE_ALLOWANCE;

/** A 413 with the limit named, so a caller learns the bound rather than guessing. */
export function bodyTooLarge(error: BodyTooLargeError): Response {
  return Response.json({ error: error.message }, { status: 413 });
}

/**
 * Read and parse a turn body, refusing one that is too large *before* it is held
 * in memory. `readBodyText` checks the declared length first and then cuts the
 * stream, so a lying `content-length` cannot decide how much is read.
 *
 * @throws {BodyTooLargeError}
 */
export async function readTurnBody(request: Request): Promise<unknown> {
  const text = await readBodyText(request, MAX_TURN_BODY_BYTES);
  return JSON.parse(text);
}

export { BodyTooLargeError };
