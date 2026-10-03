"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Stack, Text } from "@mantine/core";
import { CopyableUrl } from "@/app/_components/CopyableUrl";
import { agentWebhookPath } from "@/domain/trigger/types";
import type { AgentCredentialPurpose } from "@/domain/auth/agentCredential";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { SecretControl } from "@/app/_components/SecretControl";
import { LoadingText } from "@/app/_components/PageState";
import { generateAgentToken, getAgentToken, revealAgentToken, revokeAgentToken, type AgentCredentialStatus } from "../../lib/api";
import { useLocale, useT } from "@/app/_i18n/provider";
import { formatDate } from "@/shared/date";

export function TokenSection({ agentName, purpose, onSelect, selected, onChange, children }: {
  agentName: string; purpose: AgentCredentialPurpose; onSelect?: () => void; selected?: boolean;
  onChange?: () => void; children?: React.ReactNode;
}) {
  const t = useT();
  const locale = useLocale();
  const label = t(purpose === "api" ? "pset.apiToken" : "webhook.personalToken");
  const [status, setStatus] = useState<AgentCredentialStatus | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    setStatus(null); setError(undefined);
    void getAgentToken(agentName, purpose).then(value => { if (current) setStatus(value); })
      .catch(error => { if (current) setError(error instanceof Error ? error.message : "Could not load agent token"); });
    return () => { current = false; };
  }, [agentName, purpose]);
  const badge = status &&
    <Badge color={status.configured ? "teal" : "gray"} radius="xl">
      {t(status.configured ? "secrets.configured" : "secrets.notConfigured")}
    </Badge>;
  const content = error ? <Alert color="red">{error}</Alert> : !status ? <LoadingText /> : <Stack><SecretControl key={`${agentName}:${purpose}`}
      label={label} showHeading={false} configured={status.configured} masked={status.masked}
      description={t(purpose === "api" ? "secrets.agentTokenHint" : "webhook.personalTokenHint")}
      details={status.createdAt ? t("secrets.createdAt", { date: formatDate(status.createdAt, locale) }) : undefined}
      onReveal={status.canIssue ? () => revealAgentToken(agentName, purpose) : undefined}
      generateDisabled={!status.canIssue}
      onGenerate={async () => {
        const result = await generateAgentToken(agentName, purpose);
        setStatus({ configured: true, masked: result.masked, credentialId: result.credentialId, createdAt: result.createdAt, canIssue: true });
        onChange?.();
        return result.token;
      }}
      onRevoke={async () => { await revokeAgentToken(agentName, purpose); setStatus({ configured: false, canIssue: status.canIssue }); onChange?.(); }} />
      {purpose === "webhook" && status.credentialId && <>
        <CopyableUrl url={`${window.location.origin}${agentWebhookPath(agentName, status.credentialId)}`} />
        <Text size="sm" c="dimmed">{t("webhook.githubHint")}</Text>
      </>}
    </Stack>;
  return <CollapsibleSection title={purpose === "webhook" ? t("webhook.section") : label} onSelect={onSelect} selected={selected}
    selectLabel={onSelect ? t("pint.historyView") : undefined} badge={badge}><Stack gap="md">{content}{children}</Stack></CollapsibleSection>;
}
