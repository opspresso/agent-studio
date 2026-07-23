import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "@/lib/config";

const PREFIX = "enc:v1:";
// Stored layout after the prefix: base64(iv(12) + tag(16) + ciphertext).
const IV_AND_TAG_LENGTH = 28;

function getKey(): Buffer {
  const key = Buffer.from(config.aesEncryptionKey, "base64");
  if (key.length !== 32) {
    throw new Error("AES_ENCRYPTION_KEY must be 32 bytes base64-encoded");
  }
  return key;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptSecret(plaintext: string): string {
  if (isEncrypted(plaintext)) {
    return plaintext;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) {
    return value;
  }
  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

/** True when `value` is an all-asterisk mask produced by {@link maskSecret}. */
export function isMasked(value: string): boolean {
  return value.length > 0 && /^\*+$/.test(value);
}

/**
 * Mask a secret with asterisks matching the plaintext's UTF-8 byte length.
 * For encrypted values the length is derived from the ciphertext (AES-GCM
 * preserves plaintext length) without decrypting.
 */
export function maskSecret(value: string): string {
  if (!isEncrypted(value)) {
    return "*".repeat(Buffer.byteLength(value, "utf8"));
  }
  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  return "*".repeat(Math.max(raw.length - IV_AND_TAG_LENGTH, 0));
}

/** Encrypt all header values for storage. */
export function encryptHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, encryptSecret(v)]),
  );
}

/** Mask all header values for client reads. */
export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, maskSecret(v)]),
  );
}

/**
 * Merge a client-submitted header update against stored (encrypted) headers.
 * Masked or empty values keep the stored ciphertext; new plaintext replaces it.
 * A masked or empty value under a key with no stored counterpart is dropped —
 * a mask can only confirm an existing secret, never create one.
 */
export function mergeHeaderUpdate(
  stored: Record<string, string>,
  update: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(update)) {
    if (isMasked(value) || value === "") {
      if (stored[key] !== undefined) {
        merged[key] = stored[key];
      }
      continue;
    }
    merged[key] = encryptSecret(value);
  }
  return merged;
}

/** Decrypt stored headers for outbound calls. Only call at dispatch time. */
export function decryptHeadersForOutbound(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, decryptSecret(v)]),
  );
}
