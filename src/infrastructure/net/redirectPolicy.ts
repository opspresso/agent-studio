/** Redirect behavior shared by guarded public fetches and declared internal fetches. */
export const MAX_OUTBOUND_REDIRECTS = 5;
export const OUTBOUND_REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301,
  302,
  303,
  307,
  308,
]);
