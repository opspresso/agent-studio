/** One installation-wide lease for rebuilding the capability vector space. */
export interface CatalogReindexLock {
  /** The release token when acquired; null while another instance owns it. */
  acquire(leaseMs: number): Promise<string | null>;
  /** Releases only the lease identified by `token`. */
  release(token: string): Promise<void>;
}

/** Longer than a full run; a crashed holder expires and another pass can retry. */
export const CATALOG_REINDEX_LEASE_MS = 15 * 60_000;
