"use client";

import { useEffect, useState } from "react";
import { Alert, Avatar, Card, Group, Stack, Table, Text, Title } from "@mantine/core";
import { IconUsers } from "@tabler/icons-react";
import type { Member } from "@/domain/member/types";
import { readJson } from "@/app/_lib/httpClient";
import { useViewer } from "@/app/_lib/useViewer";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function MembersPage() {
  const viewer = useViewer();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!viewer?.isAdmin) return;
    let cancelled = false;
    fetch("/api/members")
      .then((res) => readJson<{ members: Member[] }>(res))
      .then((data) => !cancelled && setMembers(data.members))
      .catch((loadError) => !cancelled && setError(loadError instanceof Error ? loadError.message : "Failed to load members"))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [viewer?.isAdmin]);

  if (viewer === null) return <Text c="dimmed">Loading…</Text>;
  if (!viewer.isAdmin) return <Alert color="gray">Members are available to registry administrators only.</Alert>;

  return (
    <Stack gap="lg">
      <Group gap="md">
        <IconUsers size={30} />
        <div>
          <Title order={1} fz="h2">Members</Title>
          <Text c="dimmed" fz="sm">People who have signed in to this workspace.</Text>
        </div>
      </Group>

      {error ? (
        <Alert color="red">{error}</Alert>
      ) : loading ? (
        <Text c="dimmed">Loading…</Text>
      ) : members.length === 0 ? (
        <Card><Text c="dimmed" fz="sm">No members yet.</Text></Card>
      ) : (
        <Table.ScrollContainer minWidth={680}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Member</Table.Th>
                <Table.Th>Joined</Table.Th>
                <Table.Th>Last login</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {members.map((member) => (
                <Table.Tr key={member.id}>
                  <Table.Td>
                    <Group gap="sm" wrap="nowrap">
                      <Avatar src={member.image} radius="xl">{member.name.slice(0, 1)}</Avatar>
                      <div>
                        <Text fz="sm" fw={500}>{member.name}</Text>
                        <Text fz="xs" c="dimmed">{member.email}</Text>
                      </div>
                    </Group>
                  </Table.Td>
                  <Table.Td><Text fz="sm">{formatDate(member.joinedAt)}</Text></Table.Td>
                  <Table.Td>
                    <Text fz="sm" c={member.lastLoginAt ? undefined : "dimmed"}>
                      {member.lastLoginAt ? formatDate(member.lastLoginAt) : "Never recorded"}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Stack>
  );
}
