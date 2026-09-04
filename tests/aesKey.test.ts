import { describe, expect, it } from "vitest";
import { decodeAes256Key } from "@/shared/aesKey";

describe("decodeAes256Key", () => {
  it("decodes a canonical 32-byte key", () => {
    const bytes = Buffer.alloc(32, 7);
    expect(decodeAes256Key(bytes.toString("base64"))).toEqual(bytes);
  });

  it.each([
    "AA==",
    Buffer.alloc(31).toString("base64"),
    Buffer.alloc(33).toString("base64"),
    Buffer.alloc(32).toString("base64url"),
    `${Buffer.alloc(32).toString("base64")}\n`,
  ])("rejects a non-canonical or wrong-sized key", (value) => {
    expect(() => decodeAes256Key(value)).toThrow(
      "AES_ENCRYPTION_KEY must be 32 bytes in canonical base64",
    );
  });
});
