import { toMemberTier, tierAtLeast, type MemberTier } from "@/domain/member/tiers";
import { unauthorized } from "@/shared/unauthorized";
import { headers } from "next/headers";
import { auth } from "./auth";
import { isEffectiveAdmin } from "./memberAccess";
import { isConfiguredAdmin } from "./runtime-settings";
import { resolvePublicBaseUrl } from "./public-url";

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
 * route the browser-supplied Origin must name this deployment exactly; absent
 * Origin is refused because HTML forms can spend cookies without custom
 * headers. The public URL covers a reverse proxy whose external origin differs
 * from the server-side request URL.
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

/**
 * Like {@link withAuth}, but 403s a tier below `member` — today that is
 * `guest`, the tier every sign-up starts as.
 *
 * The middle rung of the three wrappers, one per tier: {@link withAuth} asks
 * only for a session, this asks for `member`, {@link withAdminAuth} asks for
 * `admin`. It gates the capability registries the console's Intelligence
 * section reads — skills, MCP tools, plugins, and the model
 * catalogue — which are a catalogue of what this deployment can reach rather
 * than anything a guest's own work needs. A guest still *runs* projects bound to those capabilities:
 * resolution happens server-side and never consults the reader's tier.
 *
 * Two routes under those paths are deliberately outside it. The OAuth callback
 * belongs to a project's connection flow rather than the console, and the
 * client-metadata document is fetched by an authorization server that carries
 * no session at all.
 */
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

/**
 * Like {@link withAuth}, but additionally 403s non-admins. Used for mutations
 * on shared registries (MCP servers and skills).
 *
 * Not built on {@link withMemberAuth}, though the ladder would suggest it:
 * "admin" here is `isEffectiveAdmin`, which reads an empty `ADMIN_EMAILS` as no
 * restriction, and `memberAccess.ts` keeps that deliberately so a deployment
 * without the list behaves as it did before tiers existed. Stacking the rungs
 * would quietly revoke that. The registry *reads* are gated regardless, so a
 * guest on such a deployment has no console path to a mutation.
 */
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
