import type { ZodError } from "zod";
import { RateLimitedError, statusForError, ValidationError } from "@/application/errors";
import { log } from "@/shared/logger";
import { isSlug } from "@/shared/slug";

/**
 * Validate a route `[name]` param as a slug. Throws {@link ValidationError}
 * (→ 400 via {@link apiError}) on anything else.
 */
export function parseName(name: string): string {
  if (!isSlug(name)) {
    throw new ValidationError("Invalid name");
  }
  return name;
}

/**
 * 400 response for a failed zod parse. `error` carries the first issue so a
 * client that only reads the field (the chat panel does) still learns what was
 * wrong; `issues` carries the rest.
 */
export function invalidRequest(error: ZodError): Response {
  const first = error.issues[0];
  const detail = first
    ? first.path.length
      ? `${first.path.join(".")}: ${first.message}`
      : first.message
    : "Invalid request";
  return Response.json({ error: detail, issues: error.issues }, { status: 400 });
}

/**
 * Map an application error to its HTTP response; unknown errors become 500.
 *
 * A typed error answers with its own message, and until it also answered with a
 * log line, typing one *removed* it from the record: an xAI 404 that used to
 * arrive here untyped — logged, then flattened to "Internal server error" — went
 * to the caller in full and left the server with nothing to grep. Better for the
 * caller, worse for whoever is asked about it an hour later.
 *
 * Only 5xx. A 4xx is the API working: a bad body, a name that is not there, a
 * caller without rights. Logging those buries the failures that matter under
 * every rejected request, which is the reason there was no log here to begin
 * with. `warn` rather than `error` because a 502 is another system's fault and
 * needs no page — `error` stays what it was, the failures this app could not
 * account for at all.
 *
 * A route that runs something long passes its `request`, and a caller who
 * hung up before the answer is then neither of the above: the run's abort
 * reaches this catch as whatever Next aborted the signal with (its own
 * `ResponseAborted`, an Error with no message), and mapped like an error it
 * was an *unhandled* one — `error`-level, for a reload. Nothing is sent, since
 * nobody is there to read it, and one `info` line says what happened: the
 * ~60-second image generation a person reloaded through used to leave a 502
 * in the log with nothing after the colon, and this line is what would have
 * named it.
 */
export function apiError(error: unknown, request?: Request): Response {
  if (request?.signal.aborted) {
    log.info("api", "caller left before the answer");
    return new Response(null, { status: 499 });
  }
  const status = statusForError(error);
  if (status !== null) {
    if (status >= 500) {
      log.warn("api", "request failed", error);
    }
    return Response.json(
      { error: (error as Error).message },
      {
        status,
        // A 429 without it tells the caller to back off and nothing about how
        // far, which is how a client ends up retrying in a tight loop against
        // the very limit that refused it.
        ...(error instanceof RateLimitedError
          ? { headers: { "Retry-After": String(error.retryAfterSeconds) } }
          : {}),
      },
    );
  }
  log.error("api", "unhandled error", error);
  return Response.json({ error: "Internal server error" }, { status: 500 });
}
