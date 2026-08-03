import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which tenant the current work belongs to.
 *
 * Every row this app writes belongs to exactly one tenant, and the key builders
 * take it explicitly so a missing scope is a type error rather than a
 * cross-tenant read. What they cannot do is *find* it: a repository method is
 * called from a use case that has no business knowing about tenancy, so the
 * value rides the async context the way a run's correlation id does
 * (`runContext.ts`), set once at the boundary that authenticated the caller.
 *
 * **Unset means {@link DEFAULT_TENANT}**, and that is the compatibility
 * contract, not an oversight: a deployment that never enters a scope is a
 * single-tenant deployment, whose rows keep exactly the keys they already have
 * (see `scope()` in `infrastructure/db/keys.ts`). An installed copy is defined
 * as "the same artifact with one tenant" rather than as a separate code path.
 */

/** The tenant a deployment runs as until something says otherwise. */
export const DEFAULT_TENANT = "default";

const storage = new AsyncLocalStorage<string>();

/** The tenant the current work belongs to. */
export function currentTenant(): string {
  return storage.getStore() ?? DEFAULT_TENANT;
}

/**
 * Run `fn` as `tenant`. Async-scoped, so everything it awaits — including a
 * repository three layers down — reads the same answer.
 */
export function withTenant<T>(tenant: string, fn: () => T): T {
  return storage.run(tenant, fn);
}
