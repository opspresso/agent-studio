/**
 * PKCE (RFC 7636) and the opaque `state` an authorization is tracked by.
 *
 * Both halves are generated here so the verifier and its challenge can never be
 * derived by two different rules — a challenge that does not match its verifier
 * fails only at the token endpoint, long after the user has left.
 */

import { createHash, randomBytes } from "node:crypto";

/** RFC 7636 §4.1: 43–128 chars from the unreserved set. 32 bytes → 43 chars. */
const VERIFIER_BYTES = 32;
const STATE_BYTES = 32;

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

export function createPkcePair(): PkcePair {
  const verifier = base64url(randomBytes(VERIFIER_BYTES));
  return {
    verifier,
    // S256 only. `plain` leaks the verifier to anyone who sees the
    // authorization request, which is the attack PKCE exists to stop.
    challenge: base64url(createHash("sha256").update(verifier).digest()),
    method: "S256",
  };
}

/**
 * An unguessable value binding a callback to the request that started it. Long
 * enough that it cannot be enumerated, since possessing one is what lets a
 * callback claim an in-flight authorization.
 */
export function createOAuthState(): string {
  return base64url(randomBytes(STATE_BYTES));
}
