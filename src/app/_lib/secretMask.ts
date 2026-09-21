/** Shorten only the server's hidden span so both visible edges fit in the field. */
export function compactSecretMask(masked: string): string {
  return masked.replace(/•{9,}/g, "••••••••");
}
