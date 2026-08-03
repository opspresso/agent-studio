/**
 * The one spelling of an address.
 *
 * A membership is keyed by email, and a key either matches or it does not: a
 * row written for `bruce@corp.com` is invisible to a lookup for
 * `Bruce@Corp.com`. What makes that worse than an ordinary miss is how it
 * reads — `resolveWorkspace` sees no memberships and answers "this person is in
 * no workspace", which hands them the default tenant and the pre-tenant
 * `ADMIN_EMAILS` rules, the exact fail-open the workspace design says must not
 * apply to a member. So both ends normalize, and they normalize here.
 *
 * Case only. The domain is case-insensitive by the spec and every provider this
 * app signs in with treats the local part that way too, but nothing else is
 * touched: to some providers `a.b@x` and `ab@x` are different people, and
 * folding them here would merge two accounts on a guess.
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
