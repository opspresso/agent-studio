// A 32-byte key must be present before the encryption module reads config.
process.env.AES_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

import { describe, expect, it } from "vitest";
import {
  decryptHeadersForOutbound,
  encryptHeaders,
  isEncrypted,
} from "@/lib/secret-encryption";

describe("header encryption round-trip", () => {
  it("encrypts header values and decrypts them back for outbound calls", () => {
    const headers = { Authorization: "Bearer secret-token", "X-Api-Key": "abc123" };
    const encrypted = encryptHeaders(headers);

    expect(encrypted.Authorization).not.toBe(headers.Authorization);
    expect(isEncrypted(encrypted.Authorization!)).toBe(true);
    expect(isEncrypted(encrypted["X-Api-Key"]!)).toBe(true);

    const decrypted = decryptHeadersForOutbound(encrypted);
    expect(decrypted).toEqual(headers);
  });
});
