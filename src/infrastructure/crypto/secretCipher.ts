/**
 * AES-256-GCM adapter for the {@link SecretCipher} port.
 *
 * A thin binding over the existing functions in `secretEncryption.ts` and
 * `timingSafe.ts` — those keep owning the format (`enc:v1:`), the masking tiers
 * and the constant-time comparison, so nothing about stored data changes here.
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
import { timingSafeEqualString } from "./timingSafe";

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
  decryptEquals: (stored, candidate) => timingSafeEqualString(decryptSecret(stored), candidate),
};
