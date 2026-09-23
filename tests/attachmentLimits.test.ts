import { describe, expect, it } from "vitest";
import {
  attachedDocumentSchema,
  attachedImageSchema,
  attachedImagesSchema,
} from "@/app/api/_lib/attachments";
import { base64ByteLength, MAX_IMAGE_BYTES, MAX_IMAGES_PER_TURN } from "@/domain/llm/imageLimits";

describe("inbound attachment limits", () => {
  it("accepts an image of exactly the byte cap the composer allows", () => {
    // The client rejects `size > MAX_IMAGE_BYTES`, so a file at the cap
    // reaches the API and must not be rejected there.
    const b64 = Buffer.alloc(MAX_IMAGE_BYTES).toString("base64");
    expect(attachedImageSchema.safeParse({ b64, mimeType: "image/png" }).success).toBe(true);
  });

  it("rejects an image past the byte cap", () => {
    const b64 = Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64").replace(/=+$/, "");
    const result = attachedImageSchema.safeParse({ b64, mimeType: "image/png" });
    expect(result.success).toBe(false);
  });

  /**
   * Measured against a real encode rather than against the formula it is the
   * inverse of, so a wrong exponent cannot agree with itself.
   */
  it("weighs a base64 string without decoding it, padding and all", () => {
    for (const size of [0, 1, 2, 3, 4, 5, 1023, 1024, 5 * 1024 * 1024]) {
      const encoded = Buffer.alloc(size, 0x41).toString("base64");
      expect(base64ByteLength(encoded)).toBe(size);
    }
  });

  it("rejects more images than one turn allows", () => {
    const image = { b64: "aGk=", mimeType: "image/png" };
    expect(attachedImagesSchema.safeParse(Array(MAX_IMAGES_PER_TURN).fill(image)).success).toBe(true);
    expect(attachedImagesSchema.safeParse(Array(MAX_IMAGES_PER_TURN + 1).fill(image)).success).toBe(
      false,
    );
  });

  it("rejects malformed base64 before a decoder can normalize it", () => {
    expect(attachedImageSchema.safeParse({ b64: "!!!!", mimeType: "image/png" }).success).toBe(
      false,
    );
    expect(
      attachedDocumentSchema.safeParse({
        b64: "a===",
        mimeType: "text/plain",
        name: "notes.txt",
      }).success,
    ).toBe(false);
    for (const b64 of ["Zh==", "Zh", "Zm9="]) {
      expect(attachedImageSchema.safeParse({ b64, mimeType: "image/png" }).success).toBe(false);
      expect(attachedDocumentSchema.safeParse({ b64, mimeType: "text/plain", name: "notes.txt" }).success).toBe(false);
    }
  });

  it("accepts canonical base64 with or without padding", () => {
    for (const b64 of ["Zg==", "Zg", "Zm8=", "Zm8"]) {
      expect(attachedImageSchema.safeParse({ b64, mimeType: "image/png" }).success).toBe(true);
      expect(attachedDocumentSchema.safeParse({ b64, mimeType: "text/plain", name: "notes.txt" }).success).toBe(true);
    }
  });
});
