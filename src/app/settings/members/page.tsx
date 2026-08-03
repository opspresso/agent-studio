"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { BADGE } from "@/app/_components/badgeColors";
import { monoInput } from "@/app/_components/monoInput";
import { useViewer } from "@/app/_lib/useViewer";
import {
  createOrganization,
  deleteOrganization,
  listMembers,
  listOrganizations,
  removeMember,
  setMember,
  type Membership,
  type Organization,
  type OrganizationRole,
} from "../api";

/**
 * Workspaces and who is in them.
 *
 * This screen is what makes multi-tenancy reachable: the key scheme, the role
 * matrix and the workspace settings layer all depend on organization and
 * membership rows that nothing else in the product could create.
 *
 * A deployment with no workspaces is the normal case and stays that way — this
 * page tells an operator what registering one does before they do it, because
 * it is not a decision that undoes itself: an id becomes the key prefix its
 * rows carry.
 */
const ROLES: OrganizationRole[] = ["viewer", "editor", "admin"];

const ROLE_COLOR: Record<OrganizationRole, string> = {
  viewer: BADGE.neutral,
  editor: "cyan",
  admin: BADGE.owned,
};

const ROLE_HINT: Record<OrganizationRole, string> = {
  viewer: "reads and runs every project in the workspace",
  editor: "a viewer who may also create and write their own projects",
  admin: "an editor who may write anyone's project and change the workspace",
};

export default function MembersPage() {
  const viewer = useViewer();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [members, setMembers] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [newId, setNewId] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrganizationRole>("viewer");

  const refreshOrganizations = useCallback(async () => {
    const rows = await listOrganizations();
    setOrganizations(rows);
    setSelected((current) => current ?? rows[0]?.id ?? null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    refreshOrganizations()
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load workspaces");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshOrganizations]);

  useEffect(() => {
    if (!selected) {
      setMembers([]);
      return;
    }
    let cancelled = false;
    listMembers(selected)
      .then((rows) => {
        if (!cancelled) {
          setMembers(rows);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load members");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  /** Every mutation reports its own failure and reloads what it touched. */
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  const create = () =>
    run(async () => {
      const created = await createOrganization({ id: newId, displayName: newDisplayName });
      setNewId("");
      setNewDisplayName("");
      await refreshOrganizations();
      setSelected(created.id);
      setNote(
        `Workspace '${created.id}' registered, with you as its admin. Sign out and back in for your session to move into it.`,
      );
    });

  const invite = () =>
    run(async () => {
      if (!selected) {
        return;
      }
      await setMember(selected, inviteEmail, inviteRole);
      setInviteEmail("");
      setMembers(await listMembers(selected));
    });

  const changeRole = (email: string, role: OrganizationRole) =>
    run(async () => {
      if (!selected) {
        return;
      }
      await setMember(selected, email, role);
      setMembers(await listMembers(selected));
    });

  const remove = (email: string) =>
    run(async () => {
      if (!selected || !confirm(`Remove ${email} from '${selected}'?`)) {
        return;
      }
      await removeMember(selected, email);
      setMembers(await listMembers(selected));
    });

  const destroy = () =>
    run(async () => {
      if (
        !selected ||
        !confirm(
          `Delete the workspace record '${selected}'? Its data rows are NOT deleted — they stay under the T#${selected}# key prefix and become unreachable from the console.`,
        )
      ) {
        return;
      }
      const left = await deleteOrganization(selected);
      setSelected(null);
      await refreshOrganizations();
      setNote(left);
    });

  if (loading) {
    return (
      <Text fz="sm" c="dimmed">
        Loading…
      </Text>
    );
  }

  const current = organizations.find((organization) => organization.id === selected) ?? null;
  const canRegister = viewer?.isDeploymentAdmin === true;

  return (
    <Stack gap="lg" maw={860}>
      <div>
        <Title order={1} fz="h2">
          Workspaces
        </Title>
        <Text fz="sm" c="dimmed" mt={4}>
          A workspace keeps its projects, chats, skills, tools and usage apart from every other
          one&rsquo;s. Someone with no membership is in the unnamed default workspace, which is
          what a single-tenant deployment stays.
        </Text>
      </div>

      {error && (
        <Alert color="red" variant="light" onClose={() => setError(null)} withCloseButton>
          {error}
        </Alert>
      )}
      {note && (
        <Alert color="yellow" variant="light" onClose={() => setNote(null)} withCloseButton>
          {note}
        </Alert>
      )}

      {organizations.length === 0 && (
        <Alert variant="light" color="gray">
          This deployment has no workspaces. Everything lives in the default one, and the tenant
          key prefix is empty — which is why adopting workspaces costs an existing install
          nothing.
        </Alert>
      )}

      {organizations.length > 0 && (
        <Card component="section">
          <Stack gap="md">
            <Group gap="sm" align="flex-end" wrap="wrap">
              <Select
                label="Workspace"
                value={selected}
                onChange={setSelected}
                data={organizations.map((organization) => ({
                  value: organization.id,
                  label: `${organization.displayName} (${organization.id})`,
                }))}
                allowDeselect={false}
                w={320}
                styles={monoInput}
              />
              {current && canRegister && (
                <Button variant="default" color="red" onClick={destroy} disabled={busy}>
                  Delete workspace
                </Button>
              )}
            </Group>

            {current && (
              <Table highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Member</Table.Th>
                    <Table.Th w={160}>Role</Table.Th>
                    <Table.Th w={100} />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {members.map((member) => (
                    <Table.Tr key={member.userEmail}>
                      <Table.Td>
                        <Text ff="monospace" fz="sm">
                          {member.userEmail}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Select
                          value={member.role}
                          onChange={(role) =>
                            role && changeRole(member.userEmail, role as OrganizationRole)
                          }
                          data={ROLES}
                          allowDeselect={false}
                          disabled={busy}
                          size="xs"
                          styles={monoInput}
                        />
                      </Table.Td>
                      <Table.Td>
                        <Button
                          variant="default"
                          size="compact-xs"
                          onClick={() => remove(member.userEmail)}
                          disabled={busy}
                        >
                          Remove
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                  {members.length === 0 && (
                    <Table.Tr>
                      <Table.Td colSpan={3}>
                        <Text fz="sm" c="dimmed">
                          No members.
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  )}
                </Table.Tbody>
              </Table>
            )}

            {current && (
              <Group gap="sm" align="flex-end" wrap="wrap">
                <TextInput
                  label="Add or update a member"
                  placeholder="person@example.com"
                  value={inviteEmail}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setInviteEmail(value);
                  }}
                  miw={260}
                  style={{ flex: 1 }}
                  styles={monoInput}
                />
                <Select
                  label="Role"
                  value={inviteRole}
                  onChange={(role) => role && setInviteRole(role as OrganizationRole)}
                  data={ROLES}
                  allowDeselect={false}
                  w={140}
                  styles={monoInput}
                />
                <Button onClick={invite} disabled={busy || !inviteEmail.trim()}>
                  Save member
                </Button>
              </Group>
            )}

            <Group gap="md" wrap="wrap">
              {ROLES.map((role) => (
                <Group key={role} gap={6} wrap="nowrap">
                  <Badge color={ROLE_COLOR[role]}>{role}</Badge>
                  <Text fz="xs" c="dimmed">
                    {ROLE_HINT[role]}
                  </Text>
                </Group>
              ))}
            </Group>
          </Stack>
        </Card>
      )}

      {canRegister && (
        <Card component="section">
          <Stack gap="md">
            <Text fz="sm" fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: "0.05em" }}>
              Register a workspace
            </Text>
            <Text fz="xs" c="dimmed">
              The id becomes the key prefix every row of the workspace carries, so it cannot be
              changed afterwards. You become its first admin. Existing data stays in the default
              workspace — <Text component="span" ff="monospace">scripts/retenant-table.ts</Text>{" "}
              is what moves it.
            </Text>
            <Group gap="sm" align="flex-end" wrap="wrap">
              <TextInput
                label="Id"
                placeholder="acme"
                value={newId}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setNewId(value);
                }}
                w={200}
                styles={monoInput}
              />
              <TextInput
                label="Display name"
                placeholder="Acme Inc."
                value={newDisplayName}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setNewDisplayName(value);
                }}
                miw={220}
                style={{ flex: 1 }}
              />
              <Button onClick={create} disabled={busy || !newId.trim()}>
                Register
              </Button>
            </Group>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
