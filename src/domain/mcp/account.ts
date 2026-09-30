import type { McpServerAuth } from "./types";

/** Provider identity used only for the connection display, never for authorization. */
export interface McpConnectedAccount {
  provider: "github" | "google";
  label: string;
}

/** Bound provider-controlled labels before storing or displaying them. */
export function readMcpConnectedAccount(value: unknown): McpConnectedAccount | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { provider, label } = value as Record<string, unknown>;
  if (provider !== "github" && provider !== "google") return undefined;
  if (typeof label !== "string" || !label.trim() || label.length > 320 || /[\u0000-\u001f\u007f]/.test(label)) return undefined;
  return { provider, label: label.trim() };
}

/** Only official OAuth endpoints may send a grant to these providers' identity APIs. */
export function mcpAccountProvider(auth: McpServerAuth): McpConnectedAccount["provider"] | undefined {
  if (
    auth.authorizationEndpoint === "https://github.com/login/oauth/authorize" &&
    auth.tokenEndpoint === "https://github.com/login/oauth/access_token" &&
    auth.issuer === "https://github.com/login/oauth"
  ) return "github";
  if (
    auth.issuer === "https://accounts.google.com" &&
    auth.authorizationEndpoint === "https://accounts.google.com/o/oauth2/v2/auth" &&
    auth.tokenEndpoint === "https://oauth2.googleapis.com/token"
  ) return "google";
  return undefined;
}

/** Google requires identity consent to return the connected email address. */
export function mcpAccountScopes(auth: McpServerAuth, scopes: readonly string[]): string[] {
  return mcpAccountProvider(auth) === "google"
    ? [...new Set([...scopes, "openid", "email"])]
    : [...scopes];
}

export type McpAccountResult =
  | { status: "resolved"; account: McpConnectedAccount }
  | { status: "unsupported" | "unavailable" };

export interface McpAccountClient {
  /** An unavailable identity must not invalidate an otherwise usable OAuth grant. */
  read(auth: McpServerAuth, accessToken: string): Promise<McpAccountResult>;
}
