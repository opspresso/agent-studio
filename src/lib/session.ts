import { toMemberTier, tierAtLeast, type MemberTier } from "@/domain/member/tiers";
import { unauthorized } from "@/shared/unauthorized";
import { headers } from "next/headers";
import { auth } from "./auth";
import { isEffectiveAdmin } from "./memberAccess";
import { isConfiguredAdmin } from "./runtime-settings";
import { resolvePublicBaseUrl } from "./public-url";
import { config } from "./config";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
  /** Fresh every request — `getSession` reads the user row, tier included. */
  tier: MemberTier;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return null;
  }
  const { user } = session;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    image: user.image ?? null,
    tier: (await isConfiguredAdmin(user.email))
      ? "admin"
      : toMemberTier((user as { tier?: unknown }).tier),
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Whether a browser request may spend a session cookie on a mutation.
 *
 * Bearer- and signature-authenticated routes do not call this. For a session
 * route the browser-supplied Origin must name the serving host exactly; absent
 * Origin is refused because HTML forms can spend cookies without custom
 * headers. The public URL covers a reverse proxy whose external origin differs
 * from the server-side request URL. Multi-domain installs instead compare the
 * preserved Host against the sign-in allowlist and its configured protocol.
 */
export async function isSameOriginMutation(
  request: Request,
  resolveBaseUrl: (fallbackOrigin?: string) => Promise<string> = resolvePublicBaseUrl,
): Promise<boolean> {
  if (SAFE_METHODS.has(request.method.toUpperCase())) {
    return true;
  }
  const rawOrigin = request.headers.get("origin");
  if (!rawOrigin || rawOrigin === "null") {
    return false;
  }
  try {
    const origin = new URL(rawOrigin).origin;
    // The Origin grammar is scheme + authority only. Normalising an attacker-
    // supplied URL with a path into an allowed origin would accept a malformed
    // header that no browser emits.
    if (rawOrigin !== origin) {
      return false;
    }
    const authBaseUrl = config.authBaseUrl;
    if (authBaseUrl && typeof authBaseUrl === "object") {
      const host = (request.headers.get("host") ?? new URL(request.url).host).toLowerCase();
      return authBaseUrl.allowedHosts.includes(host) && origin === `${authBaseUrl.protocol}://${host}`;
    }
    const requestOrigin = new URL(request.url).origin;
    if (origin === requestOrigin) {
      return true;
    }
    return origin === new URL(await resolveBaseUrl(requestOrigin)).origin;
  } catch {
    return false;
  }
}

/** A session exists, but this browser origin may not spend it. */
export function crossOriginForbidden(): Response {
  return Response.json({ error: "Cross-origin mutation refused" }, { status: 403 });
}

/**
 * Wrap a route handler with session enforcement.
 * Usage: `export const GET = withAuth(async (user, request, ctx) => Response.json(...))`
 */
export function withAuth<T extends unknown[]>(
  handler: (user: SessionUser, ...args: T) => Promise<Response>,
): (...args: T) => Promise<Response> {
  return async (...args: T) => {
    const user = await getSessionUser();
    if (!user) {
      return unauthorized();
    }
    const request = args[0];
    if (request instanceof Request && !(await isSameOriginMutation(request))) {
      return crossOriginForbidden();
    }
    return handler(user, ...args);
  };
}

/**
 * True when the member's tier grants admin, or the effective admin list
 * contains this user, or the list is empty (no restriction).
 */
export function isAdmin(user: SessionUser): Promise<boolean> {
  return isEffectiveAdmin(user);
}

/** Shared-resource writes and operator probes require member or admin tier. */
export function withMemberAuth<T extends unknown[]>(
  handler: (user: SessionUser, ...args: T) => Promise<Response>,
): (...args: T) => Promise<Response> {
  return withAuth(async (user, ...args: T) => {
    if (!tierAtLeast(user.tier, "member")) {
      return Response.json(
        { error: "This resource is not available to your account" },
        { status: 403 },
      );
    }
    return handler(user, ...args);
  });
}

/** Shared registry and system administration. Guests remain read-only even with an empty admin list. */
export function withAdminAuth<T extends unknown[]>(
  handler: (user: SessionUser, ...args: T) => Promise<Response>,
): (...args: T) => Promise<Response> {
  return withAuth(async (user, ...args: T) => {
    if (!(await isAdmin(user))) {
      return Response.json(
        { error: "Only admins can modify this resource" },
        { status: 403 },
      );
    }
    return handler(user, ...args);
  });
}
