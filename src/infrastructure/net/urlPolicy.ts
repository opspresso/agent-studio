/**
 * SSRF-guard adapter for the {@link UrlPolicy} port.
 *
 * `ssrfGuard` keeps owning the decision (scheme, DNS resolution, blocked
 * ranges); this only translates its `SsrfError` into the domain's
 * {@link BlockedUrlError}. Anything else propagates untouched, so a resolver
 * fault stays distinguishable from a refusal — the call sites rely on that
 * difference for their fallback messages.
 */

import { BlockedUrlError, type UrlPolicy } from "@/domain/security/urlPolicy";
import { assertPublicUrl, SsrfError } from "./ssrfGuard";

export const urlPolicy: UrlPolicy = {
  async assertAllowed(url) {
    try {
      await assertPublicUrl(url);
    } catch (error) {
      throw error instanceof SsrfError ? new BlockedUrlError(error.message) : error;
    }
  },
};
