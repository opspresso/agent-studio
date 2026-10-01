"use client";

import { useEffect, useState } from "react";
import { Alert, Anchor, Button, Card, Code, Group, Select, Stack, Text } from "@mantine/core";
import { IconLink } from "@tabler/icons-react";
import { PageHeader } from "@/app/_components/PageHeader";
import { LoadingText } from "@/app/_components/PageState";
import { useLocale, useT } from "@/app/_i18n/provider";
import { useViewer } from "@/app/_lib/useViewer";
import { readJson, jsonHeaders, assertOk } from "@/app/_lib/httpClient";
import { tierMayEdit } from "@/domain/member/tiers";
import { MESSAGING_PLATFORMS, type MessagingPlatform, type MessagingIdentity } from "@/domain/messaging/identity";
import { formatDateTime } from "@/shared/date";
import type { SanitizedAgent } from "@/app/api/agents/_lib/http";
import type { MessagingIdentitiesResponse, MessagingLinkCodeResponse } from "@/app/api/me/messaging-identities/route";

async function fetchIdentities() {
  return readJson<MessagingIdentitiesResponse>(await fetch("/api/me/messaging-identities"));
}

export default function MessagingConnections() {
  const t = useT();
  const locale = useLocale();
  const viewer = useViewer();
  const [agents, setAgents] = useState<SanitizedAgent[]>([]);
  const [agent, setAgent] = useState<string | null>(null);
  const [platform, setPlatform] = useState<MessagingPlatform>("slack");
  const [identities, setIdentities] = useState<MessagingIdentity[]>([]);
  const [issued, setIssued] = useState<MessagingLinkCodeResponse>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    void Promise.all([
      fetch("/api/agents").then(response => readJson<SanitizedAgent[]>(response)),
      fetchIdentities(),
    ]).then(([available, linked]) => {
      if (!current) return;
      setAgents(available);
      setAgent(available[0]?.name ?? null);
      setIdentities(linked.identities);
    }).catch(error => {
      if (current) setError(error instanceof Error ? error.message : "Messaging connections could not be loaded");
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (!issued) return;
    const timeout = setTimeout(() => setIssued(undefined), Math.max(0, Date.parse(issued.expiresAt) - Date.now()));
    return () => clearTimeout(timeout);
  }, [issued]);

  async function issue() {
    if (!agent || busy) return;
    setBusy(true);
    setError(undefined);
    setIssued(undefined);
    try {
      setIssued(await readJson<MessagingLinkCodeResponse>(await fetch("/api/me/messaging-identities", {
        method: "POST", headers: jsonHeaders, body: JSON.stringify({ agentName: agent, platform }),
      })));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Messaging authentication failed");
    } finally { setBusy(false); }
  }

  async function refresh(unlink?: MessagingIdentity) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (unlink) {
        await assertOk(await fetch("/api/me/messaging-identities", {
          method: "DELETE", headers: jsonHeaders, body: JSON.stringify(unlink),
        }));
      }
      setIdentities((await fetchIdentities()).identities);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Messaging connections could not be updated");
    } finally { setBusy(false); }
  }

  return <Stack maw={720} mx="auto" gap="lg">
    <PageHeader title={t("messaging.identity.title")} description={t("messaging.identity.description")} Icon={IconLink} />
    <Anchor href="/profile">{t("nav.profile")}</Anchor>
    {error && <Alert color="red">{error}</Alert>}
    {loading ? <LoadingText /> : <>
      <Select label="Agent" disabled={busy} data={agents.map(value => ({ value: value.name, label: value.displayName }))}
        value={agent} onChange={value => { setAgent(value); setIssued(undefined); }} />
      <Select label={t("messaging.identity.platform")} disabled={busy} value={platform} allowDeselect={false}
        data={MESSAGING_PLATFORMS.map(value => ({ value, label: value === "slack" ? "Slack" : value === "telegram" ? "Telegram" : "Teams" }))}
        onChange={value => { if (value) setPlatform(value as MessagingPlatform); setIssued(undefined); }} />
      <Button disabled={!agent || !viewer || !tierMayEdit(viewer.tier)} loading={busy} onClick={() => void issue()}>{t("messaging.identity.issue")}</Button>
      {issued && <Alert>
        <Text>{t("messaging.identity.instructions")}</Text>
        <Code block>{`auth ${issued.code}`}</Code>
        <Text size="sm" mt="xs">{t("messaging.identity.expires", { at: formatDateTime(issued.expiresAt, locale) })}</Text>
      </Alert>}
      <Button variant="light" disabled={busy} onClick={() => void refresh()}>{t("messaging.identity.refresh")}</Button>
      {identities.map(identity => <Card key={JSON.stringify([identity.agentName, identity.platform, identity.realm, identity.externalId])} withBorder>
        <Group justify="space-between">
          <Stack gap={2} style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            <Text fw={500}>{identity.agentName} · {identity.platform}</Text>
            <Text size="sm" c="dimmed">{identity.realm} · {identity.externalId}</Text>
          </Stack>
          <Button variant="light" color="red" disabled={busy} onClick={() => void refresh(identity)}>{t("messaging.identity.disconnect")}</Button>
        </Group>
      </Card>)}
    </>}
  </Stack>;
}
