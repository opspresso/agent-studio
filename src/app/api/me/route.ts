import { withAuth } from "@/lib/session";
import { isAdminEmail, isConfiguredAdmin } from "@/lib/runtime-settings";

/**
 * Who the caller is, for the console's own gating.
 *
 * Neither flag is derivable in the browser: the effective admin list lives in
 * settings, and the only endpoint that exposes it is admin-only — so a page
 * that wanted to know would have to probe a 403 to find out.
 *
 * Both are here, under the names the server uses, because they answer different
 * questions and the UI needs both. Sending one and letting the client infer the
 * other is what went wrong before: `isAdmin` alone fed the project edit gate, so
 * on a deployment with no `ADMIN_EMAILS` — where `isAdminEmail` means "no
 * restriction" but `assertProjectWritable` gates on `isConfiguredAdmin` — every
 * signed-in user was offered the editable form for every project and then got a
 * 403 on save. The two predicates are split on purpose in `runtime-settings.ts`;
 * they have to stay split across the wire too.
 *
 * Server-side authorization is unchanged by this; the flags only decide what the
 * UI offers.
 */
export const GET = withAuth(async (user) =>
  Response.json({
    email: user.email,
    /** May mutate shared registries and app settings. Empty list = no restriction. */
    isAdmin: await isAdminEmail(user.email),
    /** May write a project owned by someone else. Empty list = nobody. */
    isConfiguredAdmin: await isConfiguredAdmin(user.email),
  }),
);
