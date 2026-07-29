import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * The sign-in gate for pages, and the single owner of which pages are public.
 *
 * The API layer already refuses a request without a session (`withAuth`), but a
 * 401 only arrives *after* the page has rendered: a signed-out visitor used to
 * get the whole console — nav, tabs, empty tables — and an error box, with no
 * way in. Turning the navigation away before the route renders is both the
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
 * `assertProjectWritable`, which see the request that actually touches data. So a
 * cookie that is present but no longer valid reaches the page and gets its 401
 * from the API behind it; what this removes is the ordinary signed-out case,
 * which is all of them in practice.
 */
const PUBLIC_PATHS = new Set(["/", "/login"]);

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname) || getSessionCookie(request)) {
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
   * `icon.png` is the app-directory icon convention (`src/app/icon.png`), so it
   * is a route like any other and the matcher reaches it: without the exclusion
   * the browser tab on `/login` asks for the favicon, gets a redirect back to
   * `/login`, and renders HTML where an image should be.
   */
  matcher: ["/((?!api/|_next/|favicon.ico|icon.png|logo.png).*)"],
};
