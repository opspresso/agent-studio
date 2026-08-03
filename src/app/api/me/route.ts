import { isAdmin, withAuth } from "@/lib/session";
import { hasRole } from "@/domain/organization/membership";
import { isConfiguredAdmin } from "@/lib/runtime-settings";

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
 *
 * Inside a workspace both come from the membership role instead, and the
 * "empty list means everyone" fallback does not apply — a tenant's members are
 * named, so "nobody was named" cannot mean "everybody". The flag names stay the
 * same because the questions have not changed, only who answers them.
 */
export const GET = withAuth(async (user) =>
  Response.json({
    email: user.email,
    /** The workspace this session acts in; `default` on a single-tenant deployment. */
    tenant: user.tenant,
    /** The caller's role in it, absent outside a workspace. */
    ...(user.role ? { role: user.role } : {}),
    /** May mutate shared registries and app settings. */
    isAdmin: await isAdmin(user),
    /** May write a project owned by someone else. */
    isConfiguredAdmin: user.role
      ? hasRole(user.role, "admin")
      : await isConfiguredAdmin(user.email),
  }),
);
