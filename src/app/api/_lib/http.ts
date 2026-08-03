import type { ZodError } from "zod";
import { RateLimitedError, statusForError, ValidationError } from "@/application/errors";
import { machineTenant } from "@/lib/workspace";
import { withTenant } from "@/shared/tenantContext";
import { log } from "@/shared/logger";
import { isSlug, SLUG_RULE } from "@/shared/slug";

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
 * Run a machine-authenticated request inside the workspace it named, refusing a
 * name that is not one.
 *
 * The refusal is the point. `machineTenant` reads a value off a header or a
 * query parameter and it becomes the key prefix for the whole request, so a
 * typo — wrong case, a stray space — silently addresses a scope no tenant owns:
 * the credential lookup finds no row and the caller gets a bare 401 saying
 * their key is wrong when the key was fine. One owner so the three machine
 * surfaces (A2A, webhooks, Slack) cannot disagree about it.
 */
export function withMachineTenant(
  request: Request,
  run: () => Promise<Response>,
): Promise<Response> {
  const tenant = machineTenant(request);
  if (tenant === null) {
    return Promise.resolve(Response.json({ error: `tenant ${SLUG_RULE}` }, { status: 400 }));
  }
  return withTenant(tenant, run);
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
