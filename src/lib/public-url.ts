/**
 * Public URL composition shared by every feature that advertises an absolute
 * URL of this deployment (Slack event endpoints and webhook URLs).
 * Resolution order: PUBLIC_BASE_URL runtime setting → caller-provided fallback
 * origin (e.g. the current request's origin) → local dev default.
 */

import { getPublicBaseUrl } from "./runtime-settings";

export async function resolvePublicBaseUrl(fallbackOrigin?: string): Promise<string> {
  const base = (await getPublicBaseUrl()) ?? fallbackOrigin ?? "http://localhost:3000";
  return base.replace(/\/+$/, "");
}

export async function buildPublicUrl(path: string, fallbackOrigin?: string): Promise<string> {
  return `${await resolvePublicBaseUrl(fallbackOrigin)}${path}`;
}
