import { describe, expect, it } from "vitest";
import { BodyTooLargeError, readBodyText } from "@/lib/httpBody";

describe("readBodyText", () => {
  it("rejects a declared body that exceeds the limit without reading it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, { headers: { "Content-Length": "11" } });

    await expect(readBodyText(response, 10)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(cancelled).toBe(true);
  });

  it("cancels a chunked body as soon as accumulated bytes exceed the limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12345"));
        controller.enqueue(new TextEncoder().encode("67890"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body);

    await expect(readBodyText(response, 9)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(cancelled).toBe(true);
  });

  it("decodes a bounded multi-byte body", async () => {
    const response = new Response("안녕하세요");
    await expect(readBodyText(response, 20)).resolves.toBe("안녕하세요");
  });
});
