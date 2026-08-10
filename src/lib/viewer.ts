import type { SessionUser } from "./session";
import { isAdminEmail, isConfiguredAdmin } from "./runtime-settings";

/**
 * Who the console is being drawn for, as the UI needs to know it.
 *
 * Neither flag is derivable in the browser: the effective admin list lives in
 * settings, and the only endpoint that exposes it is admin-only — so a page that
 * wanted to know would have to probe a 403 to find out.
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
export interface Viewer {
  email: string;
  /** May mutate shared registries and app settings. Empty list = no restriction. */
  isAdmin: boolean;
  /** May write a project owned by someone else. Empty list = nobody. */
  isConfiguredAdmin: boolean;
}

/**
 * The one derivation of those flags.
 *
 * Two callers need it and they must agree: `GET /api/me`, which the pages read
 * through `useViewer`, and the root layout, which resolves the viewer for the
 * app chrome before anything renders. A second copy is how the chrome and a page
 * end up disagreeing about who is looking at them.
 */
export async function resolveViewer(user: SessionUser): Promise<Viewer> {
  return {
    email: user.email,
    isAdmin: await isAdminEmail(user.email),
    isConfiguredAdmin: await isConfiguredAdmin(user.email),
  };
}
