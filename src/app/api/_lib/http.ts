import type { ZodError } from "zod";
import { RateLimitedError, statusForError, ValidationError } from "@/application/errors";
import { log } from "@/shared/logger";

const NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * Validate a route `[name]` param as a slug. Throws {@link ValidationError}
 * (→ 400 via {@link apiError}) on anything else.
 */
export function parseName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new ValidationError("Invalid name");
  }
  return name;
}

/** 400 response for a failed zod parse. */
export function invalidRequest(error: ZodError): Response {
  return Response.json({ error: "Invalid request", issues: error.issues }, { status: 400 });
}

/** Map an application error to its HTTP response; unknown errors become 500. */
export function apiError(error: unknown): Response {
  const status = statusForError(error);
  if (status !== null) {
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
