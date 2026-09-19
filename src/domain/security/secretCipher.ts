/**
 * Port for encrypting, masking and comparing stored secrets.
 *
 * Application code holds this interface, never the Node crypto implementation:
 * the concrete cipher reads `AES_ENCRYPTION_KEY`, so use cases that referenced it
 * directly could not be tested without that environment variable.
 *
 * The method set is exactly what application code uses today — nothing was added
 * speculatively.
 */

/** Header override values; `null` removes a registry default for one Agent. */
export type HeaderOverrides = Record<string, string | null>;
export const CONTEXT_ENCRYPTED_PREFIX = "enc:v2:";

export interface SecretCipher {
  /** Encrypt new plaintext for storage, bound to its stable row/field identity. */
  encrypt(plaintext: string, context: string): string;
  /** Decrypt a stored value. Plaintext input passes through unchanged. */
  decrypt(value: string, context: string): string;
  /** Length-preserving display mask; reveals edge characters on longer values. */
  mask(value: string, context?: string): string;
  /** True when a submitted value is a mask echoed back, not a new secret. */
  isMasked(value: string): boolean;

  encryptHeaders(headers: Record<string, string>, context: string): Record<string, string>;
  maskHeaders(headers: Record<string, string>, context: string): Record<string, string>;
  /** Masked/empty submitted values keep the stored secret; unmatched masks drop. */
  mergeHeaderUpdate(
    stored: Record<string, string>,
    update: Record<string, string>,
    context: string,
  ): Record<string, string>;
  /** Decrypt stored headers for an outbound call. Only at dispatch time. */
  decryptHeadersForOutbound(
    headers: Record<string, string>,
    context: string,
  ): Record<string, string>;
  /** Registry headers with a Agent's overrides layered on, decrypted. */
  mergeOutboundHeaders(
    registryHeaders: Record<string, string>,
    overrides: HeaderOverrides | undefined,
    registryContext: string,
    overrideContext?: string,
  ): Record<string, string>;

  maskHeaderOverrides(overrides: HeaderOverrides, context: string): HeaderOverrides;
  mergeHeaderOverrideUpdate(
    stored: HeaderOverrides,
    update: HeaderOverrides,
    context: string,
    storedContext?: string,
  ): HeaderOverrides;

  /**
   * Decrypt `stored` and compare it to `candidate` in constant time.
   *
   * One operation rather than `decrypt()` plus a comparison helper: keeping it
   * behind the port means a decrypted credential never exists as a value in the
   * application layer, and callers cannot accidentally compare with `===`.
   */
  decryptEquals(stored: string, candidate: string, context: string): boolean;
}
