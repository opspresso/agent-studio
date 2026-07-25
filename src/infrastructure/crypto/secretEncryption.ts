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

// Length-preserving display masks. How much of a secret an operator may see
// scales with how much of it stays hidden — a longer value can spare more
// characters before the remainder stops being a secret:
//
//   1–8 chars    fully hidden           ********
//   9–20 chars   first 2 + last 2       ab••••••••••••yz
//   21+ chars    first 4 + last 4       abcd••••••••••••••••wxyz
//
// REVEAL_CHAR (U+2022) never appears in real API keys/tokens, so it also marks
// a mask echoed back from a form (see isMasked).
const HIDDEN_CHAR = "*";
const REVEAL_CHAR = "•";
/** [minimum length, characters revealed at each end], longest tier first. */
const REVEAL_TIERS: ReadonlyArray<readonly [number, number]> = [
  [21, 4],
  [9, 2],
];
/** Below this length nothing is ever revealed. */
const SHORTEST_REVEAL_LENGTH = REVEAL_TIERS[REVEAL_TIERS.length - 1]![0];

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

/** Tiers are chosen by character count, so a multi-byte secret is judged by what
 * is actually displayed rather than by how many bytes it occupies. */
function revealEdges(plaintext: string): string {
  const len = plaintext.length;
  const edge = REVEAL_TIERS.find(([min]) => len >= min)?.[1] ?? 0;
  // Never let the two revealed edges meet — that would print the whole secret.
  // Holds for the tiers above; it is a guard on the table, not on the input.
  if (edge === 0 || len < edge * 2 + 1) {
    return HIDDEN_CHAR.repeat(len);
  }
  return (
    plaintext.slice(0, edge) + REVEAL_CHAR.repeat(len - edge * 2) + plaintext.slice(len - edge)
  );
}

/**
 * Mask a secret for display, preserving length. See REVEAL_TIERS for how much of
 * a value is revealed at each length. Revealing the edges needs the plaintext,
 * so encrypted values are decrypted here — only in the admin/owner-gated read
 * views that call this; if decryption fails the value is fully hidden instead.
 * Values too short to reveal anything are never decrypted.
 */
export function maskSecret(value: string): string {
  const byteLength = plaintextByteLength(value);
  // UTF-8 never uses fewer bytes than characters, so a byte length below the
  // shortest revealing tier settles the question without decrypting.
  if (byteLength < SHORTEST_REVEAL_LENGTH) {
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

// --- Header overrides -------------------------------------------------------
// A version may redefine a registry server's headers. Overrides carry the same
// encryption/masking lifecycle as the registry's own headers, plus one extra
// value: `null` marks "remove this registry default", so it must survive
// encryption, masking, and update-merging untouched.

/** Values a header override map may hold; `null` removes a registry default. */
export type HeaderOverrides = Record<string, string | null>;

export function encryptHeaderOverrides(overrides: HeaderOverrides): HeaderOverrides {
  return Object.fromEntries(
    Object.entries(overrides).map(([k, v]) => [k, v === null ? null : encryptSecret(v)]),
  );
}

export function maskHeaderOverrides(overrides: HeaderOverrides): HeaderOverrides {
  return Object.fromEntries(
    Object.entries(overrides).map(([k, v]) => [k, v === null ? null : maskSecret(v)]),
  );
}

/**
 * Merge a submitted override map against the stored one, mirroring
 * {@link mergeHeaderUpdate}: a masked or empty value keeps the stored secret,
 * and a masked value with no stored counterpart is dropped — a mask can only
 * confirm an existing secret, never create one. `null` passes straight through
 * as an explicit removal.
 */
export function mergeHeaderOverrideUpdate(
  stored: HeaderOverrides,
  update: HeaderOverrides,
): HeaderOverrides {
  const merged: HeaderOverrides = {};
  for (const [key, value] of Object.entries(update)) {
    if (value === null) {
      merged[key] = null;
      continue;
    }
    if (isMasked(value) || value === "") {
      const previous = stored[key];
      if (previous !== undefined) {
        merged[key] = previous;
      }
      continue;
    }
    merged[key] = encryptSecret(value);
  }
  return merged;
}

/**
 * Final outbound headers for one MCP dispatch: the registry server's headers
 * with a version's overrides layered on. HTTP header names are case-insensitive,
 * so an override displaces a registry default that differs only by case —
 * otherwise both would be sent and the server would pick arbitrarily.
 *
 * Only call at dispatch time; both inputs are stored encrypted.
 */
export function mergeOutboundHeaders(
  registryHeaders: Record<string, string>,
  overrides: HeaderOverrides | undefined,
): Record<string, string> {
  const merged = decryptHeadersForOutbound(registryHeaders);
  for (const [key, value] of Object.entries(overrides ?? {})) {
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === key.toLowerCase()) {
        delete merged[existing];
      }
    }
    if (value !== null) {
      merged[key] = decryptSecret(value);
    }
  }
  return merged;
}
