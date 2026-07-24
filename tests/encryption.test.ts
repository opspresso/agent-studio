// A 32-byte key must be present before the encryption module reads config.
process.env.AES_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

import { describe, expect, it } from "vitest";
import {
  decryptHeadersForOutbound,
  decryptSecret,
  encryptHeaders,
  encryptSecret,
  isEncrypted,
  isMasked,
  maskHeaders,
  maskSecret,
  mergeHeaderUpdate,
} from "@/infrastructure/crypto/secretEncryption";

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

describe("length-preserving masking", () => {
  it("masks encrypted headers with asterisks matching the plaintext length", () => {
    const headers = { Authorization: "Bearer secret-token", "X-Api-Key": "abc123" };
    const masked = maskHeaders(encryptHeaders(headers));

    expect(masked.Authorization).toBe("*".repeat("Bearer secret-token".length));
    expect(masked["X-Api-Key"]).toBe("*".repeat("abc123".length));
  });

  it("masks legacy plaintext headers by their own length", () => {
    const masked = maskHeaders({ "X-Api-Key": "abc123" });
    expect(masked["X-Api-Key"]).toBe("******");
  });

  it("keeps the stored secret when an all-asterisk mask of any length is echoed back", () => {
    const stored = encryptHeaders({ Authorization: "Bearer secret-token" });
    const merged = mergeHeaderUpdate(stored, {
      Authorization: "*".repeat("Bearer secret-token".length),
    });
    expect(merged.Authorization).toBe(stored.Authorization);
  });

  it("replaces the stored secret when a new plaintext value is submitted", () => {
    const stored = encryptHeaders({ Authorization: "Bearer old" });
    const merged = mergeHeaderUpdate(stored, { Authorization: "Bearer new" });
    expect(merged.Authorization).not.toBe(stored.Authorization);
    expect(decryptSecret(merged.Authorization!)).toBe("Bearer new");
  });

  it("drops a masked value under a key with no stored counterpart (header rename)", () => {
    const stored = encryptHeaders({ Authorization: "Bearer secret-token" });
    const merged = mergeHeaderUpdate(stored, {
      "X-Renamed": "*".repeat("Bearer secret-token".length),
    });
    expect(merged).toEqual({});
  });

  it("drops an empty value under a key with no stored counterpart", () => {
    const merged = mergeHeaderUpdate({}, { "X-New": "" });
    expect(merged).toEqual({});
  });
});

describe("partial-reveal masking (>= 20 chars)", () => {
  const bullets = (n: number) => "•".repeat(n);

  it("reveals the first and last two chars of a long plaintext, hiding the middle", () => {
    const key = "sk-live-abcdefghijklmnop"; // 24 chars
    expect(maskSecret(key)).toBe(`sk${bullets(key.length - 4)}op`);
    expect(maskSecret(key)).toHaveLength(key.length);
  });

  it("decrypts an encrypted long secret at display time to reveal its edges", () => {
    const secret = "sk-proj-0123456789abcdef"; // 24 chars
    expect(maskSecret(encryptSecret(secret))).toBe(`sk${bullets(secret.length - 4)}ef`);
  });

  it("still fully hides secrets shorter than 20 chars with asterisks", () => {
    expect(maskSecret("short-secret")).toBe("*".repeat("short-secret".length));
    expect(maskSecret(encryptSecret("short-secret"))).toBe("*".repeat("short-secret".length));
  });

  it("treats a partial-reveal mask echoed back as unchanged", () => {
    const stored = encryptHeaders({ Authorization: "Bearer super-secret-token-value" });
    const masked = maskHeaders(stored).Authorization!;
    expect(masked).toContain("•");
    const merged = mergeHeaderUpdate(stored, { Authorization: masked });
    expect(merged.Authorization).toBe(stored.Authorization);
  });

  it("recognizes both asterisk and partial-reveal masks, but not real secrets", () => {
    expect(isMasked("******")).toBe(true);
    expect(isMasked(`sk${bullets(20)}op`)).toBe(true);
    expect(isMasked("sk-real-secret-value-1234")).toBe(false);
    expect(isMasked("")).toBe(false);
  });
});
