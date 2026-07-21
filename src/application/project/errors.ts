/** Application-layer errors for the project/version domain. Routes map these to HTTP status codes. */

export class NotFoundError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class ValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function statusForError(error: unknown): number | null {
  if (error instanceof NotFoundError || error instanceof ConflictError || error instanceof ValidationError) {
    return error.status;
  }
  return null;
}
