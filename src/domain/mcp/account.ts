import type { McpServerAuth } from "./types";
import type { McpAccountLookup } from "./accountLookup";
export type { McpAccountLookup } from "./accountLookup";

/** Provider identity used only for the connection display, never for authorization. */
export interface McpConnectedAccount {
  provider: "github" | "google" | "notion" | "plaud" | "oidc" | "mcp" | "http";
  label: string;
}

/** Bound provider-controlled labels before storing or displaying them. */
export function readMcpConnectedAccount(value: unknown): McpConnectedAccount | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { provider, label } = value as Record<string, unknown>;
  if (provider !== "github" && provider !== "google" && provider !== "notion" && provider !== "plaud" && provider !== "oidc" && provider !== "mcp" && provider !== "http") return undefined;
  if (typeof label !== "string" || !label.trim() || label.length > 320 || /[\u0000-\u001f\u007f]/.test(label)) return undefined;
  return { provider, label: label.trim() };
}

export function isMcpAccountEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

const CREDENTIAL_FIELDS = new Set(["accesstoken", "refreshtoken", "idtoken", "clientsecret", "password", "secret", "apikey", "authorization", "token"]);
function isCredentialField(key: string): boolean {
  return CREDENTIAL_FIELDS.has(key.replace(/[-_]/g, "").toLowerCase());
}
function containsCredentialField(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => isCredentialField(key) || containsCredentialField(nested));
}

export function readMcpAccountLookup(value: unknown): McpAccountLookup | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (input.kind === "none") return Object.keys(input).length === 1 ? { kind: "none" } : undefined;
  if (typeof input.labelPath !== "string" || (input.labelPath !== "" && !input.labelPath.startsWith("/")) || input.labelPath.length > 512 || /~(?![01])/.test(input.labelPath)) return undefined;
  if (input.labelPath.slice(1).split("/").some(part => isCredentialField(part.replace(/~1/g, "/").replace(/~0/g, "~")))) return undefined;
  try { if (JSON.stringify(input).length > 4_096) return undefined; } catch { return undefined; }
  if (input.kind === "http") {
    if (Object.keys(input).some(key => !["kind", "endpoint", "labelPath", "scopes"].includes(key))) return undefined;
    if (typeof input.endpoint !== "string" || input.endpoint.length > 2_048 || !isMcpAccountEndpoint(input.endpoint)) return undefined;
    const scopes = input.scopes;
    if (scopes !== undefined && (!Array.isArray(scopes) || scopes.length > 10 || scopes.some(scope => typeof scope !== "string" || !scope || /\s/.test(scope) || scope.length > 256))) return undefined;
    return { kind: "http", endpoint: input.endpoint, labelPath: input.labelPath, ...(scopes ? { scopes: scopes as string[] } : {}) };
  }
  if (input.kind === "mcp") {
    if (Object.keys(input).some(key => !["kind", "toolName", "arguments", "labelPath"].includes(key))) return undefined;
    if (typeof input.toolName !== "string" || !input.toolName.trim() || input.toolName.length > 128 || /[\u0000-\u001f\u007f]/.test(input.toolName)) return undefined;
    if (!input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments)) return undefined;
    if (containsCredentialField(input.arguments)) return undefined;
    return { kind: "mcp", toolName: input.toolName, arguments: JSON.parse(JSON.stringify(input.arguments)) as Record<string, unknown>, labelPath: input.labelPath };
  }
  return undefined;
}

/** RFC 6901 selection reads own JSON fields only; no wildcards, scripts or prototype traversal. */
export function accountLabelAt(value: unknown, pointer: string): unknown {
  let current = value;
  for (const part of pointer === "" ? [] : pointer.slice(1).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "number" && Number.isFinite(current) ? String(current) : current;
}

export type ResolvedMcpAccountLookup = {
  provider: McpConnectedAccount["provider"];
  lookup: Exclude<McpAccountLookup, { kind: "none" }>;
  /** Fixed, audited presets can predate read-only annotations; operator mappings cannot. */
  requireReadOnly?: boolean;
  oidc?: boolean;
};

/** Explicit operator choice wins, followed by discovered UserInfo, then built-in service contracts. */
export function resolveMcpAccountLookup(auth: McpServerAuth): ResolvedMcpAccountLookup | undefined {
  if (auth.accountLookup) {
    const lookup = readMcpAccountLookup(auth.accountLookup);
    if (!lookup || lookup.kind === "none") return undefined;
    return { provider: lookup.kind, lookup, ...(lookup.kind === "mcp" ? { requireReadOnly: true } : {}) };
  }
  const provider = mcpAccountProvider(auth);
  if (auth.userInfoEndpoint) return { provider: provider ?? "oidc", oidc: true, lookup: { kind: "http", endpoint: auth.userInfoEndpoint, labelPath: "/email", scopes: auth.userInfoScopes ?? ["openid"] } };
  if (provider === "github") return { provider, lookup: { kind: "http", endpoint: "https://api.github.com/user", labelPath: "/login" } };
  if (provider === "google") return { provider, oidc: true, lookup: { kind: "http", endpoint: "https://openidconnect.googleapis.com/v1/userinfo", labelPath: "/email", scopes: ["openid", "email"] } };
  if (provider === "notion") return { provider, lookup: { kind: "mcp", toolName: "notion-get-users", arguments: { user_id: "self" }, labelPath: "/results/0/email" } };
  if (provider === "plaud") return { provider, lookup: { kind: "mcp", toolName: "get_current_user", arguments: {}, labelPath: "/email" } };
  return undefined;
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
  if (
    (auth.issuer === "https://mcp.notion.com" || auth.issuer === "https://mcp.notion.com/") &&
    auth.authorizationEndpoint === "https://mcp.notion.com/authorize" &&
    auth.tokenEndpoint === "https://mcp.notion.com/token" &&
    auth.resource === "https://mcp.notion.com/mcp"
  ) return "notion";
  if (
    auth.issuer === "https://mcp.plaud.ai/" &&
    auth.authorizationEndpoint === "https://mcp.plaud.ai/authorize" &&
    auth.tokenEndpoint === "https://mcp.plaud.ai/token" &&
    auth.resource === "https://mcp.plaud.ai/mcp"
  ) return "plaud";
  return undefined;
}

/** Google requires identity consent to return the connected email address. */
export function mcpAccountScopes(auth: McpServerAuth, scopes: readonly string[]): string[] {
  const lookup = resolveMcpAccountLookup(auth)?.lookup;
  return [...new Set([...scopes, ...(lookup?.kind === "http" ? lookup.scopes ?? [] : [])])];
}

export type McpAccountResult =
  | { status: "resolved"; account: McpConnectedAccount }
  | { status: "not_configured" | "disabled" | "unsupported" | "unavailable" };

export interface McpAccountClient {
  /** An unavailable identity must not invalidate an otherwise usable OAuth grant. */
  read(auth: McpServerAuth, accessToken: string, context?: { mcpUrl: string; loopback?: boolean }): Promise<McpAccountResult>;
}
