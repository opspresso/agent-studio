import type { Membership, OrganizationRole } from "@/domain/organization/membership";
import type { Organization } from "@/domain/organization/types";
import { assertOk, jsonHeaders, readJson } from "@/app/_lib/httpClient";

export type { Membership, Organization, OrganizationRole };

export function listOrganizations(): Promise<Organization[]> {
  return fetch("/api/organizations")
    .then((r) => readJson<{ organizations: Organization[] }>(r))
    .then((data) => data.organizations);
}

export function createOrganization(input: {
  id: string;
  displayName: string;
}): Promise<Organization> {
  return fetch("/api/organizations", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  }).then((r) => readJson<Organization>(r));
}

export function renameOrganization(id: string, displayName: string): Promise<Organization> {
  return fetch(`/api/organizations/${id}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ displayName }),
  }).then((r) => readJson<Organization>(r));
}

/** Resolves to the note about the rows the delete deliberately left behind. */
export function deleteOrganization(id: string): Promise<string> {
  return fetch(`/api/organizations/${id}`, { method: "DELETE" })
    .then((r) => readJson<{ note: string }>(r))
    .then((data) => data.note);
}

export function listMembers(organizationId: string): Promise<Membership[]> {
  return fetch(`/api/organizations/${organizationId}/members`)
    .then((r) => readJson<{ members: Membership[] }>(r))
    .then((data) => data.members);
}

export function setMember(
  organizationId: string,
  email: string,
  role: OrganizationRole,
): Promise<Membership> {
  return fetch(`/api/organizations/${organizationId}/members`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ email, role }),
  }).then((r) => readJson<Membership>(r));
}

export async function removeMember(organizationId: string, email: string): Promise<void> {
  await assertOk(
    await fetch(`/api/organizations/${organizationId}/members/${encodeURIComponent(email)}`, {
      method: "DELETE",
    }),
  );
}
