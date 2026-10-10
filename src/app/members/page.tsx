"use client";

import { useEffect, useState } from "react";
import { NavigationLink } from "@/app/_components/NavigationLink";
import { Alert, Avatar, Group, Select, Stack, Table, Text } from "@mantine/core";
import { IconUsers } from "@tabler/icons-react";
import type { MemberTier } from "@/domain/member/tiers";
import type { Member } from "@/domain/member/types";
import type { MembersResponse } from "@/app/api/members/route";
import { PageHeader } from "@/app/_components/PageHeader";
import { DataTable } from "@/app/_components/DataTable";
import { EmptyState, LoadingText } from "@/app/_components/PageState";
import { formatDateTime } from "@/shared/date";
import { readJson } from "@/app/_lib/httpClient";
import { useViewer } from "@/app/_lib/useViewer";
import { useLocale, useT } from "@/app/_i18n/provider";
import { reportError } from "@/app/_lib/reportError";

type MemberView = MembersResponse["members"][number];

export default function MembersPage() {
  const t = useT();
  const locale = useLocale();
  const viewer = useViewer();
  const [tiers, setTiers] = useState<string[]>([]);
  const [members, setMembers] = useState<MemberView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(() => new Set());

  async function changeTier(member: MemberView, tier: MemberTier) {
    if (savingIds.has(member.id)) return;
    setSavingIds(previous => new Set(previous).add(member.id));
    setSaveError(null);
    try {
      const updated = await readJson<Member>(
        await fetch(`/api/members/${member.id}/tier`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tier }),
        }),
      );
      setMembers((prev) => prev.map((m) => (m.id === updated.id ? { ...m, ...updated } : m)));
    } catch (cause) {
      setSaveError(reportError(cause, "Failed to update tier"));
    } finally {
      setSavingIds(previous => {
        const remaining = new Set(previous);
        remaining.delete(member.id);
        return remaining;
      });
    }
  }

  useEffect(() => {
    if (!viewer?.isAdmin) return;
    let cancelled = false;
    fetch("/api/members")
      .then((res) => readJson<MembersResponse>(res))
      .then((data) => { if (!cancelled) { setMembers(data.members); setTiers(data.tiers); } })
      .catch((error) => !cancelled && setLoadError(error instanceof Error ? error.message : "Failed to load members"))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [viewer?.isAdmin]);

  const header = <PageHeader title={t("nav.members")} description={t("members.lede")} Icon={IconUsers}>
    {viewer?.isAdmin && <NavigationLink href="/usage">{t("usage.adminTitle")}</NavigationLink>}
  </PageHeader>;
  if (viewer === null || !viewer.isAdmin) return <Stack gap="lg">{header}
    {viewer === null ? <LoadingText /> : <Alert color="gray">{t("admin.adminOnlyMembers")}</Alert>}
  </Stack>;

  return (
    <Stack gap="lg">
      {header}

      {saveError && <Alert color="red" variant="light">{saveError}</Alert>}

      {loadError ? (
        <Alert color="red" variant="light">{loadError}</Alert>
      ) : loading ? (
        <LoadingText />
      ) : members.length === 0 ? (
        <EmptyState>{t("members.empty")}</EmptyState>
      ) : (
        <DataTable minWidth={780}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t("members.member")}</Table.Th>
                <Table.Th>{t("members.tier")}</Table.Th>
                <Table.Th>{t("members.joined")}</Table.Th>
                <Table.Th>{t("members.lastLogin")}</Table.Th>
                <Table.Th>{t("models.column.actions")}</Table.Th>
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
                      data={tiers}
                      value={member.tier}
                      disabled={member.tierLocked || savingIds.has(member.id)}
                      allowDeselect={false}
                      aria-label={`Tier of ${member.email}`}
                      onChange={(value) => {
                        if (value && value !== member.tier) {
                          void changeTier(member, value);
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
                  <Table.Td><NavigationLink href={`/usage?user=${encodeURIComponent(member.id)}`}>{t("usage.view")}</NavigationLink></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
        </DataTable>
      )}
    </Stack>
  );
}
