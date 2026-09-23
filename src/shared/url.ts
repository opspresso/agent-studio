/** Remove URL components that can carry credentials before returning a stored URL to a reader. */
export function urlWithoutUserinfoQueryOrFragment(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

/** The non-secret part of a URL that may be written to an operational log. */
export function urlOriginForLog(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return "invalid URL";
  }
}
