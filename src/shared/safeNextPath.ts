/**
 * The post-sign-in destination, reduced to something that cannot leave this
 * origin.
 *
 * The value reaches us in a query string that anyone can write, so a link to
 * `/login?next=https://evil.example` would otherwise turn our own sign-in flow
 * into an open redirect — with the Google credential prompt appearing on the
 * real domain first, which is exactly what makes that class of bug work. Only a
 * path is ever accepted.
 *
 * `//host` and `/\host` are paths only by spelling: browsers read both as
 * protocol-relative URLs and follow them off-origin, so a bare `startsWith("/")`
 * check is not enough. A backslash after the leading slash is rejected for the
 * same reason, since some agents normalise `\` to `/` before resolving.
 */
export function safeNextPath(raw: string | undefined | null, fallback = "/"): string {
  if (!raw || !raw.startsWith("/")) {
    return fallback;
  }
  if (raw.startsWith("//") || raw.startsWith("/\\")) {
    return fallback;
  }
  // A control character can split a `Location` header; nothing legitimate here
  // contains one.
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    return fallback;
  }
  return raw;
}
