import { BodyTooLargeError, readBodyText } from "@/shared/httpBody";
import { base64Chars } from "@/domain/llm/imageLimits";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "@/domain/llm/imageLimits";
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENTS } from "@/domain/llm/documentLimits";
import { MAX_SKILL_TOTAL_BYTES } from "@/domain/skill/files";

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
 * Ceiling on a body that carries no attachments.
 *
 * Derived from the largest thing a management route legitimately holds — a
 * skill's whole file set — with room for the prose and JSON quoting around it.
 * These routes have their own per-field caps, but every one of them is checked
 * by zod *after* `JSON.parse` has already allocated the string twice.
 */
const EDITOR_ALLOWANCE = MAX_SKILL_TOTAL_BYTES + PROSE_ALLOWANCE;

/**
 * The body of a registry or version edit, or the response that refuses it.
 *
 * Separate from {@link turnBody} because the two bound different things and the
 * gap between them is three orders of magnitude: a turn may carry four 10MB
 * attachments, and nothing a person types into the console comes close.
 */
export async function editorBody(
  request: Request,
  options: { empty?: unknown } = {},
): Promise<unknown | Response> {
  return boundedBody(request, EDITOR_ALLOWANCE, options);
}

/**
 * The body, or the response that refuses it.
 *
 * The bound above was worth nothing on the routes that never asked for it, and
 * for a while that was most of them: the chat surface read its body this way
 * while `/predict` — the same attachments, the same `attachedImagesSchema` —
 * called `request.json()` and let zod check the size once the string was already
 * resident. Every route that parses a turn now goes through here.
 *
 * It answers with a `Response` rather than throwing because the eight lines of
 * try/catch that shape used to need were themselves about to be copied five
 * times, and a refusal spelled differently on one route is how a caller learns
 * a limit exists from a 500.
 */
export async function turnBody(request: Request): Promise<unknown | Response> {
  return boundedBody(request, MAX_TURN_BODY_BYTES);
}

/**
 * Ceiling on an uploaded model catalog. The published one is under 100KB;
 * this leaves room for a deployment that declares far more routes than
 * agent-models does, and is still small enough that the JSON a 4xx is
 * decided on was never worth refusing earlier.
 */
export const MAX_CATALOG_BODY_BYTES = 4 * 1024 * 1024;

/** A catalog document an admin uploads, or the response that refuses it. */
export async function catalogBody(request: Request): Promise<unknown | Response> {
  return boundedBody(request, MAX_CATALOG_BODY_BYTES);
}

async function boundedBody(
  request: Request,
  maxBytes: number,
  options: { empty?: unknown } = {},
): Promise<unknown | Response> {
  try {
    const text = await readBodyText(request, maxBytes);
    if (text.trim() === "" && Object.hasOwn(options, "empty")) {
      return options.empty;
    }
    return JSON.parse(text);
  } catch (error) {
    return error instanceof BodyTooLargeError
      ? bodyTooLarge(error)
      : Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
}

export { BodyTooLargeError };
