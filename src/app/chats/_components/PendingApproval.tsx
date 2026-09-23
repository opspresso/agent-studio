"use client";

import { Alert, Badge, Button, Code, Group, Paper, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { useT } from "@/app/_i18n/provider";
import type { ChatWithMessages } from "@/application/chat/getChat";
import type { RuntimeApprovalDecision } from "@/domain/execution/runtimeSession";
import { assertOk } from "@/app/_lib/httpClient";

export function PendingApproval({ chatId, pending, disabled, onDecision, onDiscarded }: {
  chatId: string;
  pending: NonNullable<ChatWithMessages["pendingApproval"]>;
  disabled: boolean;
  onDecision: (decisions: RuntimeApprovalDecision[]) => void;
  onDiscarded: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const discard = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/chats/${chatId}/approval`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: pending.revision }) });
      await assertOk(response);
      onDiscarded();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  return <Paper withBorder p="md" radius="md">
    <Stack gap="sm">
      <Text fw={600}>{t("chat.approvalTitle")}</Text>
      {error && <Alert color="red">{error}</Alert>}
      {pending.status === "running" ? <Alert color="orange">{t("chat.approvalInterrupted")}</Alert> : <>
        <Text size="sm" c="dimmed">{t("chat.approvalHint")}</Text>
        {pending.approvals.map((approval) => <Stack key={approval.id} gap="xs">
          <Group gap="xs"><Badge variant="light">{approval.agent}</Badge><Text fw={500} size="sm">{approval.tool}</Text></Group>
          <Code block style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 220, overflowY: "auto", overflowX: "hidden" }}>{approval.arguments}</Code>
          <Group gap="xs">
            <Button size="xs" aria-label={`${t("chat.approve")} ${approval.tool} (${approval.agent})`} disabled={disabled || busy} onClick={() => onDecision([{ id: approval.id, approve: true }])}>{t("chat.approve")}</Button>
            <Button size="xs" aria-label={`${t("chat.reject")} ${approval.tool} (${approval.agent})`} variant="light" color="red" disabled={disabled || busy} onClick={() => onDecision([{ id: approval.id, approve: false }])}>{t("chat.reject")}</Button>
          </Group>
        </Stack>)}
      </>}
      <Text size="xs" c="dimmed">{t("chat.discardApprovalHint")}</Text>
      <Button size="xs" variant="subtle" color="gray" loading={busy} disabled={disabled} onClick={() => void discard()}>{t("chat.discardApproval")}</Button>
    </Stack>
  </Paper>;
}
