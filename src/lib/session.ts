import { toMemberTier, type MemberTier } from "@/domain/member/tiers";
import { unauthorized } from "@/shared/unauthorized";
import { headers } from "next/headers";
import { auth } from "./auth";
import { isEffectiveAdmin } from "./memberAccess";
import { isConfiguredAdmin } from "./runtime-settings";

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
 * Like {@link withAuth}, but additionally 403s non-admins. Used for mutations
 * on shared registries (MCP servers, external agents, skills).
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
