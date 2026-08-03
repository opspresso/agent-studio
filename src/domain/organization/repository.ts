import type { Membership } from "./membership";
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

export interface MembershipRepository {
  get(organizationId: string, userEmail: string): Promise<Membership | null>;
  /** Everyone in one tenant. */
  listByOrganization(organizationId: string): Promise<Membership[]>;
  /**
   * Every tenant one person belongs to. Read on each authenticated request, so
   * it is an index lookup rather than a scan.
   */
  listByUser(userEmail: string): Promise<Membership[]>;
  put(membership: Membership): Promise<void>;
  delete(organizationId: string, userEmail: string): Promise<void>;
}
