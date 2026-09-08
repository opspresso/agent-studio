/** Static artifact views do not execute scripts. */
export const ARTIFACT_VIEW_POLICY = [
  "sandbox",
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

/**
 * The wrapper and its srcdoc child inherit this policy. The child also has its
 * own sandbox, so their opaque origins are distinct. frame-src blocks child
 * navigation and nested network frames while permitting inline srcdoc content.
 * This restricts web fetches, not every browser networking API (notably WebRTC).
 * Never serve untrusted HTML directly with this script-capable policy.
 */
export const INTERACTIVE_HTML_VIEW_POLICY = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

export const ARTIFACT_VIEW_PERMISSIONS = [
  "camera=()", "microphone=()", "geolocation=()", "display-capture=()",
  "clipboard-read=()", "clipboard-write=()", "payment=()", "usb=()",
].join(", ");

/** Decode before placing the original document inside an isolated child. */
export function decodeArtifactHtml(bytes: Uint8Array, mimeType: string): string | null {
  const charset = /;\s*charset\s*=\s*"?([A-Za-z0-9._-]+)"?/i.exec(mimeType)?.[1] ?? "utf-8";
  try { return new TextDecoder(charset, { fatal: true }).decode(bytes); } catch { return null; }
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
