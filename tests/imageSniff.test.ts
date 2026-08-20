/**
 * The sniffer answers with a member of `SUPPORTED_IMAGE_TYPES`, and the type
 * system only checks that in one direction: narrowing the list breaks the
 * build, while *widening* it compiles clean and leaves the sniffer with no
 * branch for the new format. That gap is not theoretical — a surface that
 * declares its type (Slack) would forward the file while a surface that does
 * not (Teams pastes arrive as `image/*`) would drop it as unsupported, with the
 * two lists disagreeing and nothing saying so.
 *
 * So the other direction is a test: every supported format needs a sample here,
 * and every sample has to be recognised from its first bytes.
 */

import { describe, expect, it } from "vitest";
import { SUPPORTED_IMAGE_TYPES, type SupportedImageType } from "@/domain/llm/imageLimits";
import { sniffImageType } from "@/domain/llm/imageSniff";

/** First bytes of a real file of each format, padded to the length each check reads. */
const SAMPLES: Record<SupportedImageType, number[]> = {
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/jpeg": [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10],
  "image/gif": [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  "image/webp": [
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ],
};

describe("sniffing a picture's type", () => {
  it.each(SUPPORTED_IMAGE_TYPES)("recognises %s, which the models may be sent", (type) => {
    const sample = SAMPLES[type];
    // A format added to the list with no sample here is the failure this exists
    // for: the sniffer would have no branch for it either.
    expect(sample, `no magic-byte sample for ${type}`).toBeDefined();
    expect(sniffImageType(new Uint8Array(sample!))).toBe(type);
  });

  it("says nothing about bytes it does not recognise", () => {
    expect(sniffImageType(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeUndefined();
    expect(sniffImageType(new Uint8Array([]))).toBeUndefined();
    // A truncated header is not a match: every check reads a full signature.
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBeUndefined();
  });

  it("does not mistake a RIFF container that is not WebP", () => {
    const wav = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45];
    expect(sniffImageType(new Uint8Array(wav))).toBeUndefined();
  });
});
