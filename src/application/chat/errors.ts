/** Application-level chat errors carrying the HTTP status the route should surface. */
export class ChatError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = new.target.name;
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
