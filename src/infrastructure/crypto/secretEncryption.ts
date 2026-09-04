import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "@/lib/config";
import { decodeAes256Key } from "@/shared/aesKey";

const V1_PREFIX = "enc:v1:";
const V2_PREFIX = "enc:v2:";
// Stored layout after the prefix: base64(iv(12) + tag(16) + ciphertext).
const IV_AND_TAG_LENGTH = 28;

function getKey(): Buffer {
  return decodeAes256Key(config.aesEncryptionKey);
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(V1_PREFIX) || value.startsWith(V2_PREFIX);
}

export function encryptSecret(plaintext: string, context?: string): string {
  if (context === "") {
    throw new Error("secret encryption context must not be empty");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  if (context !== undefined) {
    cipher.setAAD(Buffer.from(context, "utf8"));
  }
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const prefix = context === undefined ? V1_PREFIX : V2_PREFIX;
  return prefix + Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptSecret(value: string, context?: string): string {
  if (!isEncrypted(value)) {
    return value;
  }
  const prefix = value.startsWith(V2_PREFIX) ? V2_PREFIX : V1_PREFIX;
  if (prefix === V2_PREFIX && !context) {
    throw new Error("enc:v2 secret requires its encryption context");
  }
  const raw = Buffer.from(value.slice(prefix.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
  if (prefix === V2_PREFIX) {
    decipher.setAAD(Buffer.from(context!, "utf8"));
  }
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
  const prefix = value.startsWith(V2_PREFIX) ? V2_PREFIX : V1_PREFIX;
  const raw = Buffer.from(value.slice(prefix.length), "base64");
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
export function maskSecret(value: string, context?: string): string {
  const byteLength = plaintextByteLength(value);
  // UTF-8 never uses fewer bytes than characters, so a byte length below the
  // shortest revealing tier settles the question without decrypting.
  if (byteLength < SHORTEST_REVEAL_LENGTH) {
    return HIDDEN_CHAR.repeat(byteLength);
  }
  try {
    return revealEdges(isEncrypted(value) ? decryptSecret(value, context) : value);
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
      // Own keys only. A header may be named anything an operator types, and a
      // plain lookup answers `constructor` with a function off
      // `Object.prototype` — carried through as a stored secret until
      // `decryptSecret` is handed a function at dispatch time.
      const previous = Object.hasOwn(stored, key) ? stored[key] : undefined;
      if (previous !== undefined) {
        merged[key] = previous;
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
      // Own keys only, as in {@link mergeHeaderUpdate}.
      const previous = Object.hasOwn(stored, key) ? stored[key] : undefined;
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
 *
 * A masked override is dropped rather than sent, and that is a safety net for a
 * caller that failed to resolve one — see the note on the skip below. Callers
 * that take a version from a form must still resolve masks against the stored
 * version first ({@link mergeHeaderOverrideUpdate}); this only bounds the damage
 * when one does not, because the alternative is silent and expensive.
 */
export function mergeOutboundHeaders(
  registryHeaders: Record<string, string>,
  overrides: HeaderOverrides | undefined,
): Record<string, string> {
  const merged = decryptHeadersForOutbound(registryHeaders);
  for (const [key, value] of Object.entries(overrides ?? {})) {
    // A mask is a display artifact a form echoed back, never a credential.
    // Sending one is wrong twice over: `fetch` rejects it outright, because the
    // reveal character is outside Latin-1 and a header must be a ByteString —
    // and for the values it does not reject, it would hand the first and last
    // characters of a real secret to a third-party server. Skipping leaves the
    // registry's own header standing, which is what "no override" means.
    if (value !== null && isMasked(value)) {
      continue;
    }
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
