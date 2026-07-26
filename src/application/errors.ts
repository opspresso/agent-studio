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
