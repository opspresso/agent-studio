"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Card, Group, Select, Stack, Table, Text, Title } from "@mantine/core";
import type { AuditAction, AuditEvent } from "@/domain/audit/types";
import { BADGE } from "@/app/_components/badgeColors";
import { DateRangePicker } from "@/app/_components/DateRangePicker";
import { presetRange, type DateRange } from "@/app/_lib/dateRange";

/**
 * Who did what, and when.
 *
 * Read one Query per UTC day, which is why the range is bounded server-side and
 * why the default here is a week rather than the 30 days the usage pages use:
 * this is a "what happened" screen, not a trend.
 *
 * The rows never carry the secret itself — a row saying a token was revealed is
 * the trail; a row containing the token would be a second copy of the thing the
 * trail exists to protect.
 */
const ACTION_COLOR: Record<AuditAction, string> = {
  "secret.reveal": BADGE.attention,
  "secret.issue": BADGE.attention,
  "secret.revoke": BADGE.broken,
  "settings.update": "cyan",
  "project.delete": BADGE.broken,
  "registry.delete": BADGE.broken,
  "authz.admin-override": "violet",
  "organization.create": BADGE.owned,
  "organization.delete": BADGE.broken,
  "membership.grant": BADGE.owned,
  "membership.revoke": "orange",
};

const ALL_ACTIONS = "all";

export default function AuditPage() {
  const [range, setRange] = useState<DateRange>(() => presetRange(7));
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [action, setAction] = useState<string>(ALL_ACTIONS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/audit?from=${range.from}&to=${range.to}`)
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          events?: AuditEvent[];
          error?: string;
        };
        if (cancelled) {
          return;
        }
        if (!res.ok) {
          // The range cap and the admin gate both answer here; the server's own
          // wording says which, and it is more specific than anything this page
          // could guess.
          setError(data.error ?? `Request failed (${res.status})`);
          setEvents([]);
          return;
        }
        setEvents(data.events ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load the audit log");
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
  }, [range]);

  // Client-side, because the rows for a range are already here: a server round
  // trip per filter change would re-read the same day partitions.
  const shown = action === ALL_ACTIONS ? events : events.filter((event) => event.action === action);
  const present = [...new Set(events.map((event) => event.action))].sort();

  return (
    <Stack gap="lg">
      <div>
        <Title order={1} fz="h2">
          Audit log
        </Title>
        <Text fz="sm" c="dimmed" mt={4}>
          Sensitive acts in this workspace: credentials revealed, issued or revoked, settings
          written, projects and registry entries deleted, ownership overridden, members changed.
          Rows expire on the deployment&rsquo;s retention setting.
        </Text>
      </div>

      <Group gap="md" align="flex-end" wrap="wrap">
        <DateRangePicker value={range} onChange={setRange} />
        <Select
          label="Action"
          size="xs"
          value={action}
          onChange={(value) => setAction(value ?? ALL_ACTIONS)}
          data={[{ value: ALL_ACTIONS, label: "all actions" }, ...present]}
          allowDeselect={false}
          w={220}
        />
      </Group>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {loading ? (
        <Text fz="sm" c="dimmed">
          Loading…
        </Text>
      ) : (
        <Card component="section" p={0}>
          <Table.ScrollContainer minWidth={720}>
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={200}>When (UTC)</Table.Th>
                  <Table.Th w={180}>Action</Table.Th>
                  <Table.Th w={220}>Who</Table.Th>
                  <Table.Th>What</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {shown.map((event) => (
                  <Table.Tr key={event.id}>
                    <Table.Td>
                      <Text ff="monospace" fz="xs">
                        {event.createdAt.replace("T", " ").replace(/\.\d+Z$/, "Z")}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge color={ACTION_COLOR[event.action] ?? BADGE.neutral}>
                        {event.action}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text ff="monospace" fz="xs">
                        {event.actorEmail}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text ff="monospace" fz="xs">
                        {event.target}
                      </Text>
                      {event.detail && (
                        <Text fz="xs" c="dimmed">
                          {event.detail}
                        </Text>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
                {shown.length === 0 && !error && (
                  <Table.Tr>
                    <Table.Td colSpan={4}>
                      <Text fz="sm" c="dimmed" p="md">
                        Nothing recorded in this range.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      )}
    </Stack>
  );
}
