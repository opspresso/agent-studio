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

// Length-preserving display masks. Shorter values are fully hidden; values of
// at least REVEAL_MIN_LENGTH reveal their first/last REVEAL_EDGE characters so an
// operator can recognize which secret is set. REVEAL_CHAR (U+2022) never appears
// in real API keys/tokens, so it also marks a mask echoed back from a form.
const HIDDEN_CHAR = "*";
const REVEAL_CHAR = "•";
const REVEAL_MIN_LENGTH = 20;
const REVEAL_EDGE = 2;

/** True when `value` is a mask produced by {@link maskSecret} (a form echoing
 * the displayed value back unchanged), never a freshly typed secret. */
export function isMasked(value: string): boolean {
  return value.length > 0 && (value.includes(REVEAL_CHAR) || /^\*+$/.test(value));
}

/** Plaintext byte length without decrypting — AES-GCM preserves plaintext length. */
function plaintextByteLength(value: string): number {
  if (!isEncrypted(value)) {
    return Buffer.byteLength(value, "utf8");
  }
  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  return Math.max(raw.length - IV_AND_TAG_LENGTH, 0);
}

function revealEdges(plaintext: string): string {
  const len = plaintext.length;
  if (len < REVEAL_MIN_LENGTH) {
    return HIDDEN_CHAR.repeat(len);
  }
  return (
    plaintext.slice(0, REVEAL_EDGE) +
    REVEAL_CHAR.repeat(len - REVEAL_EDGE * 2) +
    plaintext.slice(len - REVEAL_EDGE)
  );
}

/**
 * Mask a secret for display, preserving length. Values shorter than 20 chars are
 * fully hidden; longer ones reveal their first and last two characters. Revealing
 * the edges needs the plaintext, so encrypted values are decrypted here — only in
 * the admin/owner-gated read views that call this; if decryption fails the value
 * is fully hidden instead. Short values are never decrypted.
 */
export function maskSecret(value: string): string {
  const byteLength = plaintextByteLength(value);
  if (byteLength < REVEAL_MIN_LENGTH) {
    return HIDDEN_CHAR.repeat(byteLength);
  }
  try {
    return revealEdges(isEncrypted(value) ? decryptSecret(value) : value);
  } catch {
    return HIDDEN_CHAR.repeat(byteLength);
  }
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
