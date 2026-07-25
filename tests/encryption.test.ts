// A 32-byte key must be present before the encryption module reads config.
process.env.AES_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

import { describe, expect, it } from "vitest";
import {
  decryptHeadersForOutbound,
  decryptSecret,
  encryptHeaderOverrides,
  encryptHeaders,
  encryptSecret,
  isEncrypted,
  isMasked,
  maskHeaderOverrides,
  maskHeaders,
  maskSecret,
  mergeHeaderOverrideUpdate,
  mergeHeaderUpdate,
  mergeOutboundHeaders,
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

describe("MCP header overrides", () => {
  it("encrypts values but carries the null delete marker through untouched", () => {
    const encrypted = encryptHeaderOverrides({
      Authorization: "Bearer project-token",
      "X-Drop-Me": null,
    });
    expect(isEncrypted(encrypted.Authorization as string)).toBe(true);
    expect(encrypted["X-Drop-Me"]).toBeNull();
  });

  it("masks values but leaves the delete marker visible as null", () => {
    const masked = maskHeaderOverrides(
      encryptHeaderOverrides({ Authorization: "Bearer super-secret-token-value", "X-Gone": null }),
    );
    expect(masked.Authorization).not.toContain("secret");
    expect(masked.Authorization).toContain("•");
    expect(masked["X-Gone"]).toBeNull();
  });

  it("keeps the stored secret when a masked or empty value is submitted back", () => {
    const stored = encryptHeaderOverrides({ Authorization: "Bearer super-secret-token-value" });
    const masked = maskHeaderOverrides(stored).Authorization as string;

    expect(mergeHeaderOverrideUpdate(stored, { Authorization: masked }).Authorization).toBe(
      stored.Authorization,
    );
    expect(mergeHeaderOverrideUpdate(stored, { Authorization: "" }).Authorization).toBe(
      stored.Authorization,
    );
  });

  it("drops a masked value that has no stored counterpart", () => {
    // A mask can only confirm an existing secret, never create one.
    expect(mergeHeaderOverrideUpdate({}, { "X-New": "******" })).toEqual({});
  });

  it("replaces a stored value when a new plaintext secret is typed", () => {
    const stored = encryptHeaderOverrides({ Authorization: "Bearer old" });
    const merged = mergeHeaderOverrideUpdate(stored, { Authorization: "Bearer new" });
    expect(merged.Authorization).not.toBe(stored.Authorization);
    expect(decryptSecret(merged.Authorization as string)).toBe("Bearer new");
  });

  it("keeps an explicit removal across an update round-trip", () => {
    const stored = encryptHeaderOverrides({ "X-Tenant": null });
    expect(mergeHeaderOverrideUpdate(stored, { "X-Tenant": null })["X-Tenant"]).toBeNull();
  });
});

describe("mergeOutboundHeaders", () => {
  const registry = encryptHeaders({
    Authorization: "Bearer registry-default",
    "X-Shared": "shared-value",
  });

  it("returns the registry headers unchanged when a binding has no overrides", () => {
    expect(mergeOutboundHeaders(registry, undefined)).toEqual({
      Authorization: "Bearer registry-default",
      "X-Shared": "shared-value",
    });
    expect(mergeOutboundHeaders(registry, {})).toEqual({
      Authorization: "Bearer registry-default",
      "X-Shared": "shared-value",
    });
  });

  it("overwrites a registry default, adds a new header, and removes a default", () => {
    const merged = mergeOutboundHeaders(
      registry,
      encryptHeaderOverrides({
        Authorization: "Bearer project-token",
        "X-Tenant": "acme",
        "X-Shared": null,
      }),
    );
    expect(merged).toEqual({
      Authorization: "Bearer project-token",
      "X-Tenant": "acme",
    });
  });

  it("lets two bindings send different credentials to the same registry server", () => {
    const a = mergeOutboundHeaders(registry, encryptHeaderOverrides({ Authorization: "Bearer a" }));
    const b = mergeOutboundHeaders(registry, encryptHeaderOverrides({ Authorization: "Bearer b" }));
    expect(a.Authorization).toBe("Bearer a");
    expect(b.Authorization).toBe("Bearer b");
    // The shared registry header still reaches both.
    expect(a["X-Shared"]).toBe("shared-value");
    expect(b["X-Shared"]).toBe("shared-value");
  });

  it("displaces a registry header that differs only by case", () => {
    // HTTP header names are case-insensitive; sending both would let the server
    // pick arbitrarily between the registry default and the override.
    const merged = mergeOutboundHeaders(
      registry,
      encryptHeaderOverrides({ authorization: "Bearer lowercase" }),
    );
    expect(Object.keys(merged).filter((k) => k.toLowerCase() === "authorization")).toEqual([
      "authorization",
    ]);
    expect(merged.authorization).toBe("Bearer lowercase");
  });

  it("removes a registry default whose case differs from the override key", () => {
    const merged = mergeOutboundHeaders(registry, { "x-shared": null });
    expect(Object.keys(merged)).toEqual(["Authorization"]);
  });
});
