import { isAdmin, withAuth } from "@/lib/session";

/**
 * Who the caller is, for the console's own gating.
 *
 * `isAdmin` is not derivable in the browser: the effective admin list lives in
 * settings, and the only endpoint that exposes it is admin-only — so a page
 * that wanted to know would have to probe a 403 to find out. Server-side
 * authorization is unchanged by this; the flag only decides what the UI offers.
 */
export const GET = withAuth(async (user) =>
  Response.json({ email: user.email, isAdmin: await isAdmin(user) }),
);
