"use client";

import { useEffect, useState } from "react";
import { Alert, Avatar, Card, Group, Select, Stack, Table, Text } from "@mantine/core";
import { IconUsers } from "@tabler/icons-react";
import { MEMBER_TIERS, type MemberTier } from "@/domain/member/tiers";
import type { Member } from "@/domain/member/types";
import { PageHeader } from "@/app/_components/PageHeader";
import { EmptyState, LoadingText } from "@/app/_components/PageState";
import { formatDateTime } from "@/shared/date";
import { readJson } from "@/app/_lib/httpClient";
import { useViewer } from "@/app/_lib/useViewer";
import { useLocale, useT } from "@/app/_i18n/provider";

type MemberView = Member & { tierLocked: boolean };

export default function MembersPage() {
  const t = useT();
  const locale = useLocale();
  const viewer = useViewer();
  const [members, setMembers] = useState<MemberView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  async function changeTier(member: MemberView, tier: MemberTier) {
    setSavingId(member.id);
    setError(null);
    try {
      const updated = await readJson<Member>(
        await fetch(`/api/members/${member.id}/tier`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tier }),
        }),
      );
      setMembers((prev) => prev.map((m) => (m.id === updated.id ? { ...m, ...updated } : m)));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to update tier");
    } finally {
      setSavingId(null);
    }
  }

  useEffect(() => {
    if (!viewer?.isAdmin) return;
    let cancelled = false;
    fetch("/api/members")
      .then((res) => readJson<{ members: MemberView[] }>(res))
      .then((data) => !cancelled && setMembers(data.members))
      .catch((loadError) => !cancelled && setError(loadError instanceof Error ? loadError.message : "Failed to load members"))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [viewer?.isAdmin]);

  if (viewer === null) return <LoadingText />;
  if (!viewer.isAdmin) return <Alert color="gray">{t("admin.adminOnlyMembers")}</Alert>;

  return (
    <Stack gap="lg">
      <PageHeader
        title={t("nav.members")}
        description={t("members.lede")}
        Icon={IconUsers}
      />

      {error ? (
        <Alert color="red" variant="light">{error}</Alert>
      ) : loading ? (
        <LoadingText />
      ) : members.length === 0 ? (
        <EmptyState>{t("members.empty")}</EmptyState>
      ) : (
        <Table.ScrollContainer minWidth={780}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Member</Table.Th>
                <Table.Th>Tier</Table.Th>
                <Table.Th>Joined</Table.Th>
                <Table.Th>{t("members.lastLogin")}</Table.Th>
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
                  <Table.Td>
                    <Select
                      size="xs"
                      w={110}
                      data={[...MEMBER_TIERS]}
                      value={member.tier}
                      disabled={member.tierLocked || savingId === member.id}
                      allowDeselect={false}
                      aria-label={`Tier of ${member.email}`}
                      onChange={(value) => {
                        if (value && value !== member.tier) {
                          void changeTier(member, value as MemberTier);
                        }
                      }}
                    />
                  </Table.Td>
                  <Table.Td><Text fz="sm">{formatDateTime(member.joinedAt, locale)}</Text></Table.Td>
                  <Table.Td>
                    <Text fz="sm" c={member.lastLoginAt ? undefined : "dimmed"}>
                      {member.lastLoginAt ? formatDateTime(member.lastLoginAt, locale) : t("members.neverRecorded")}
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
