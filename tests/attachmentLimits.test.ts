import { describe, expect, it } from "vitest";
import { attachedImageSchema, attachedImagesSchema } from "@/app/api/_lib/attachments";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "@/domain/llm/imageLimits";

/** Padded base64 length of a file of exactly `bytes` bytes — deliberately not
 *  the module's own helper, so a wrong formula there cannot pass this test. */
function base64Chars(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

describe("inbound attachment limits", () => {
  it("accepts an image of exactly the byte cap the composer allows", () => {
    // The client rejects `size > MAX_ATTACHMENT_BYTES`, so a file at the cap
    // reaches the API and must not be rejected there.
    const b64 = "A".repeat(base64Chars(MAX_ATTACHMENT_BYTES));
    expect(attachedImageSchema.safeParse({ b64, mimeType: "image/png" }).success).toBe(true);
  });

  it("rejects an image past the byte cap", () => {
    const b64 = "A".repeat(base64Chars(MAX_ATTACHMENT_BYTES + 3 * 1024));
    const result = attachedImageSchema.safeParse({ b64, mimeType: "image/png" });
    expect(result.success).toBe(false);
  });

  it("rejects more images than one turn allows", () => {
    const image = { b64: "aGk=", mimeType: "image/png" };
    expect(attachedImagesSchema.safeParse(Array(MAX_ATTACHMENTS).fill(image)).success).toBe(true);
    expect(attachedImagesSchema.safeParse(Array(MAX_ATTACHMENTS + 1).fill(image)).success).toBe(
      false,
    );
  });
});
