import { describe, expect, it } from "vitest";
import { editorBody, MAX_TURN_BODY_BYTES, turnBody } from "@/app/api/_lib/body";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "@/domain/llm/imageLimits";
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENTS } from "@/domain/llm/documentLimits";

/**
 * `body.ts` already said why an unbounded body is a problem — "several hundred
 * megabytes of resident memory per request, from any signed-in caller, before a
 * single validator has looked at it" — and then only the chat routes asked for
 * the bound. `/predict` took the same attachments through `request.json()`, so
 * its `attachedImagesSchema` checked the size once the string was resident.
 */
function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://x.test/api/thing", { method: "POST", body, headers });
}

describe("turnBody", () => {
  it("parses a body within the cap", async () => {
    expect(await turnBody(post(JSON.stringify({ prompt: "hi" })))).toEqual({ prompt: "hi" });
  });

  it("refuses one over it with a 413 rather than parsing it", async () => {
    const oversized = JSON.stringify({ pad: "a".repeat(MAX_TURN_BODY_BYTES) });

    const result = await turnBody(post(oversized));

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });

  it("answers a malformed body with 400, not 413", async () => {
    // The two are different problems and a caller acts differently on each.
    const result = await turnBody(post("{not json"));

    expect((result as Response).status).toBe(400);
  });

  it("leaves room for every attachment a turn may legally carry", async () => {
    // The cap is derived, so this pins the derivation rather than a number: a
    // request at the documented limits must not be refused by the body reader.
    const attachments =
      MAX_DOCUMENT_BYTES * MAX_DOCUMENTS + MAX_ATTACHMENT_BYTES * MAX_ATTACHMENTS;

    expect(MAX_TURN_BODY_BYTES).toBeGreaterThan(attachments);
  });
});

describe("editorBody", () => {
  it("is orders of magnitude tighter than a turn's", async () => {
    // Nothing typed into the console approaches four 10MB attachments, and a
    // registry route that accepted one would be a memory sink with no feature
    // behind it.
    const result = await editorBody(post(JSON.stringify({ pad: "a".repeat(2 * 1024 * 1024) })));

    expect((result as Response).status).toBe(413);
  });

  it("still takes a skill's whole file set", async () => {
    // The bound is derived from exactly this, so a skill at its documented
    // limit has to survive the reader that protects it.
    const files = { files: [{ path: "a.md", content: "x".repeat(180 * 1024) }] };

    expect(await editorBody(post(JSON.stringify(files)))).toEqual(files);
  });
});
