/**
 * The one distinction the tool layer has to make about a failure: whether its
 * message was written for the caller.
 *
 * Everything that refuses a document on purpose — a format this does not read,
 * a scan with no text layer, an archive over the budget, a password — raises a
 * `DocumentError`, and its message goes back to the model verbatim because it
 * was written to be read there. Anything else is a bug in this server, and its
 * message is whatever the runtime happened to say; that is reported as a
 * failure without the detail, because a stack-shaped string in a tool result
 * teaches a model nothing and can carry more about this process than the caller
 * should have.
 */
export class DocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
