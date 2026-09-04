/**
 * AES-256-GCM adapter for the {@link SecretCipher} port.
 *
 * A thin binding over the existing functions in `secretEncryption.ts` and
 * `timingSafe.ts` — those keep owning the versioned format, the masking tiers
 * and the constant-time comparison. A supplied storage context produces
 * `enc:v2`; legacy context-free values remain readable as `enc:v1`.
 */

import type { SecretCipher } from "@/domain/security/secretCipher";
import {
  decryptHeadersForOutbound,
  decryptSecret,
  encryptHeaders,
  encryptSecret,
  isMasked,
  maskHeaderOverrides,
  maskHeaders,
  maskSecret,
  mergeHeaderOverrideUpdate,
  mergeHeaderUpdate,
  mergeOutboundHeaders,
} from "./secretEncryption";
import { timingSafeEqualString } from "@/shared/timingSafe";

export const secretCipher: SecretCipher = {
  encrypt: encryptSecret,
  decrypt: decryptSecret,
  mask: maskSecret,
  isMasked,
  encryptHeaders,
  maskHeaders,
  mergeHeaderUpdate,
  decryptHeadersForOutbound,
  mergeOutboundHeaders,
  maskHeaderOverrides,
  mergeHeaderOverrideUpdate,
  decryptEquals: (stored, candidate, context) =>
    timingSafeEqualString(decryptSecret(stored, context), candidate),
};
