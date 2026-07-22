import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison for secrets (API keys, signatures). Returns
 * false for unequal lengths without leaking timing on the content comparison.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
