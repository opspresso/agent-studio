export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`HTTP body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

export async function readBodyText(
  message: Pick<Request | Response, "body" | "headers">,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(message.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await message.body?.cancel();
    throw new BodyTooLargeError(maxBytes);
  }
  if (!message.body) {
    return "";
  }

  const reader = message.body.getReader();
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
        await reader.cancel();
        throw new BodyTooLargeError(maxBytes);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
