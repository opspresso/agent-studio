import { unauthorized } from "@/shared/unauthorized";
import { headers } from "next/headers";
import { auth } from "./auth";
import { isAdminEmail } from "./runtime-settings";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return null;
  }
  const { user } = session;
  return { id: user.id, email: user.email, name: user.name, image: user.image ?? null };
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

/** True when the effective admin list contains this user, or is empty (no restriction). */
export function isAdmin(user: SessionUser): Promise<boolean> {
  return isAdminEmail(user.email);
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
