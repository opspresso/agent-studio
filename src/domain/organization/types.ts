/**
 * A tenant.
 *
 * `id` is a slug and it is also the key prefix every row of this tenant carries,
 * which is why it is immutable: renaming one would orphan every row written
 * under the old name, exactly as renaming a project would.
 *
 * The default tenant (`DEFAULT_TENANT`) is not a row here. It is what a
 * deployment is when nothing says otherwise, and its rows carry no prefix at
 * all — so a single-tenant install needs no organization record to work, and
 * registering one is the deliberate step of becoming multi-tenant.
 */
export interface Organization {
  /** Slug, immutable — it is the key prefix. */
  id: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}
