import { AppError } from "@/application/errors";

/** Application-level chat errors carrying the HTTP status the route should surface. */
export class ChatError extends AppError {
  constructor(message: string, status: number) {
    super(message, status);
  }
}

export class ChatValidationError extends ChatError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class ChatNotFoundError extends ChatError {
  constructor(message = "chat not found") {
    super(message, 404);
  }
}

export class ChatForbiddenError extends ChatError {
  constructor(message = "forbidden") {
    super(message, 403);
  }
}

export class ChatConflictError extends ChatError {
  constructor(message = "chat already has a response in progress") {
    super(message, 409);
  }
}
