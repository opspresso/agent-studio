import { describe, expect, it } from "vitest";
import { BodyTooLargeError, readBodyBytes, readBodyText } from "@/shared/httpBody";

describe("abortable byte reads", () => {
  it("interrupts a stalled body and releases its reader without returning partial bytes", async () => {
    const controller = new AbortController();
    let cancelled = false;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const body = new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new Uint8Array([1])); },
      pull() { started(); },
      cancel() { cancelled = true; },
    });
    const result = readBodyBytes(new Response(body), 10, controller.signal);
    const rejected = expect(result).rejects.toThrow("worker stopped");
    await reading; controller.abort(new Error("worker stopped"));
    await rejected;
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });
  it("releases a body when cancellation preceded the read", async () => {
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await expect(readBodyBytes(new Response(body), 10, controller.signal)).rejects.toThrow("cancelled");
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });
});

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
