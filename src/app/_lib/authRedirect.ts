import { isPublicPagePath } from "@/shared/pageAccess";

export interface BrowserLocation {
  origin: string;
  pathname: string;
  search: string;
  hash: string;
  replace(url: string): void;
}

export function loginHref(location: Pick<BrowserLocation, "pathname" | "search" | "hash">): string {
  const next = `${location.pathname}${location.search}${location.hash}`;
  return `/login?${new URLSearchParams({ next }).toString()}`;
}

/** Start a full navigation so cached layouts cannot retain the expired viewer. */
export function redirectToLogin(location?: BrowserLocation): boolean {
  const current = location ?? (typeof window === "undefined" ? undefined : window.location);
  if (!current || isPublicPagePath(current.pathname)) {
    return false;
  }
  current.replace(loginHref(current));
  return true;
}

/** Redirect only for a 401 from this application's API, never an external endpoint. */
export function redirectApiUnauthorized(
  response: Pick<Response, "status" | "url">,
  location?: BrowserLocation,
): boolean {
  if (response.status !== 401) {
    return false;
  }
  const current = location ?? (typeof window === "undefined" ? undefined : window.location);
  if (!current) {
    return false;
  }
  if (response.url !== "") {
    const requested = new URL(response.url, current.origin);
    if (requested.origin !== current.origin || !requested.pathname.startsWith("/api/")) {
      return false;
    }
  }
  return redirectToLogin(current);
}
