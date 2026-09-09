/**
 * Reading an HTTP body under a byte ceiling.
 *
 * The rule has two halves and neither is enough alone: a `content-length` that
 * lies must not decide how much is pulled into memory, and a body that declares
 * no length at all must still be bounded. Both callers here answer a body from
 * somewhere else — a request from any signed-in caller, a file from a remote
 * host — where "read it and check afterwards" means the check runs once the
 * memory is already spent.
 */

export class BodyTooLargeError extends Error {
  constructor(
    readonly maxBytes: number,
    /** Present when the sender declared a length and it was already over. */
    readonly declaredBytes?: number,
  ) {
    super(`HTTP body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * Refuse a declared length over the cap before a byte is read, and give up the
 * body while doing it.
 *
 * Separate from the loops below because it is the half that is silently
 * skippable: a reader that only counts what arrives is still correct, just
 * wasteful, so an implementation missing this looks like it works.
 */
export async function refuseDeclaredLength(
  message: Pick<Request | Response, "body" | "headers">,
  maxBytes: number,
): Promise<void> {
  const declared = Number(message.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await message.body?.cancel().catch(() => {});
    throw new BodyTooLargeError(maxBytes, declared);
  }
}

/**
 * The body as text, decoded as it arrives.
 *
 * Incremental on purpose: a body at the cap would otherwise be held twice over,
 * once as bytes and once as the string, which for the turn bodies this bounds is
 * tens of megabytes of avoidable peak.
 */
export async function readBodyText(
  message: Pick<Request | Response, "body" | "headers">,
  maxBytes: number,
  options: { onBytes?: (totalBytes: number) => void | Promise<void> } = {},
): Promise<string> {
  await refuseDeclaredLength(message, maxBytes);
  const body = message.body;
  if (!body) {
    return "";
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return text + decoder.decode();
      }
      total += value.byteLength;
      if (total > maxBytes) {
        throw new BodyTooLargeError(maxBytes);
      }
      await options.onBytes?.(total);
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Same shape as `readBodyBytes` below: any exit — the cap, an `onBytes`
    // throw — must cancel the body, or the connection cannot be reused.
    reader.releaseLock();
    await body.cancel().catch(() => {});
  }
}

/**
 * The body as bytes, cutting the stream rather than measuring afterwards.
 *
 * The sibling of {@link readBodyText}, here because a third caller was about to
 * spell the rule a third time — and the one that had no bound at all was the
 * Slack file download, which answered `res.arrayBuffer()` and let the caller
 * check the size once the bytes were already resident.
 */
export async function readBodyBytes(
  message: Pick<Request | Response, "body" | "headers">,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  await refuseDeclaredLength(message, maxBytes);
  const body = message.body;
  if (!body) {
    return new Uint8Array(0);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    for (;;) {
      // Destructured on purpose. Reading the flag off a named result object
      // instead would look, to the single-owner check, exactly like this file
      // deciding why a *run* ended — a question it has no part in.
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        throw new BodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    // Releasing the lock lets the connection be reused; cancelling a body that
    // already finished is a no-op.
    reader.releaseLock();
    await body.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
