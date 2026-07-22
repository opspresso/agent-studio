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
