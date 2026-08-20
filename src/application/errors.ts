/**
 * Shared application error hierarchy. Every domain-level error carries the HTTP
 * status a route should surface, so `apiError` (and any route) can map errors
 * from any domain uniformly. Domain-specific error modules (project, chat)
 * extend or re-export these.
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string) {
    super(message, 403);
  }
}

/**
 * Something this app called failed — GitHub, an MCP server, a provider.
 *
 * A distinct type because the alternative is what the sync routes used to do:
 * re-decide the status from a substring of the message
 * (`message.includes("GitHub") ? 502 : 500`), which is case-sensitive, blind to
 * every message that does not happen to contain the word, and a second owner of
 * a mapping `apiError` already owns. 502 says "not our fault, and not something
 * retrying differently will fix", which is exactly what an operator needs to
 * know before going to look at the other system.
 */
export class UpstreamError extends AppError {
  constructor(message: string) {
    super(message, 502);
  }
}

/**
 * A refusal the caller can retry once a known amount of time has passed — a
 * daily spend cap that resets at UTC midnight, a concurrency slot that frees
 * when a lease expires.
 *
 * The wait is part of the error rather than left to the route, because the
 * thing that knows *why* the request was refused is the only thing that knows
 * when it stops being refused. `apiError` turns it into `Retry-After`.
 */
export class RateLimitedError extends AppError {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message, 429);
  }
}

/**
 * The run outlived the longest a single run may take (`MAX_RUN_DURATION_MS`).
 *
 * The one ending this platform imposes on a run that was otherwise working, and
 * until it had a type it was the only ending with no words of its own: the abort
 * reason travelled out as a `DOMException`, which `apiError` cannot place, so a
 * caller was told "Internal server error" for a limit that is documented and a
 * streaming caller was told "The operation was aborted due to timeout". 504
 * rather than 500 because nothing here failed — the answer took longer than the
 * deployment allows, and the caller's own retry decision depends on knowing
 * which of the two it was.
 */
export class RunDeadlineError extends AppError {
  constructor(message: string) {
    super(message, 504);
  }
}

/** Map any {@link AppError} to its HTTP status; `null` for non-app errors (→ 500). */
export function statusForError(error: unknown): number | null {
  return error instanceof AppError ? error.status : null;
}

/**
 * Names the storage adapter raises when a conditional write loses its
 * precondition — someone else wrote first, or the transaction carrying it was
 * cancelled.
 *
 * They are DynamoDB's, and this is the ONE place the application layer names
 * them. Seven call sites used to spell them out, which is how the two-name form
 * ended up in exactly one of them: the repository port's contract is "a
 * conditional write may fail", and each caller only decides what to say about it.
 */
const CONDITIONAL_WRITE_FAILED = "ConditionalCheckFailedException";
const TRANSACTION_CANCELED = "TransactionCanceledException";

/**
 * True when `error` is a lost conditional write. Pass `includeTransaction` where
 * the write went out inside a transaction, so its cancellation counts too.
 */
export function isConditionalWriteFailure(
  error: unknown,
  opts: { includeTransaction?: boolean } = {},
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === CONDITIONAL_WRITE_FAILED ||
    (opts.includeTransaction === true && error.name === TRANSACTION_CANCELED)
  );
}

/**
 * True when a transactional write was cancelled — its own precondition failed,
 * or a sibling operation in the same transaction did. Distinct from the
 * predicate above because a transactional path never sees the bare conditional
 * failure, and widening it would turn an unrelated fault into a 409.
 */
export function isTransactionCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === TRANSACTION_CANCELED;
}
