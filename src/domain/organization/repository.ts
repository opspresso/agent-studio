import type { Organization } from "./types";

export interface OrganizationRepository {
  get(id: string): Promise<Organization | null>;
  list(): Promise<Organization[]>;
  /** Fails if the id is taken — the id is a key prefix, so a collision is a merge. */
  create(organization: Organization): Promise<void>;
  update(organization: Organization): Promise<void>;
  /**
   * Remove the record. It does **not** remove the tenant's rows: they are
   * spread across every partition prefix and deleting them is a sweep, not a
   * cascade. A caller that means to erase a tenant has to say so separately.
   */
  delete(id: string): Promise<void>;
}
