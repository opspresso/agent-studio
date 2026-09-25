import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { isPublicPagePath } from "@/shared/pageAccess";
import { AUTH_COOKIE_PREFIX } from "@/shared/authCookies";

/**
 * The sign-in gate for pages. `pageAccess.ts` owns which pages are public.
 *
 * The API layer already refuses a request without a session (`withAuth`), but a
 * 401 only arrives *after* the page has rendered. Without this gate a signed-out
 * visitor receives the console shell and an error box despite having no way in.
 * Turning the navigation away before the route renders is both the
 * correct answer to "you are not signed in" and the only one that does not leak
 * the shape of the workspace to someone who cannot use it.
 *
 * Every path the matcher reaches needs a session unless it is listed here, so
 * adding a route defaults to protected. That direction is deliberate: the
 * failure mode of forgetting to list a public page is a redirect a user reports
 * in a minute, and the failure mode of forgetting to list a private one is
 * silent.
 *
 * What is checked is the *presence* of the session cookie, not its validity.
 * Verifying it would mean a session read on every navigation and it still would
 * not be the authorization decision — that stays server-side in `withAuth` and
 * `assertAgentWritable`, which see the request that actually touches data. So a
 * cookie that is present but no longer valid reaches the page and gets its 401
 * from the API behind it; the browser response boundary then sends the tab to
 * `/login`. This gate removes the ordinary no-cookie case before render.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  if (isPublicPagePath(pathname) || getSessionCookie(request, { cookiePrefix: AUTH_COOKIE_PREFIX })) {
    return NextResponse.next();
  }

  const login = new URL("/login", request.url);
  // Where to come back to once they are in. `/login` reads this back through
  // `safeNextPath`, because by then it is a value from the address bar.
  login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  /*
   * Everything except `/api` — whose routes authenticate themselves and must
   * answer a programmatic caller with a 401, never a redirect to an HTML page —
   * and the static asset paths, which have no session to speak of.
   *
   * Branding assets must load on public pages such as `/login` as well as in
   * the authenticated console.
   */
  matcher: [
    "/((?!api/|_next/|brands/|favicon\\.ico$).*)",
  ],
};
