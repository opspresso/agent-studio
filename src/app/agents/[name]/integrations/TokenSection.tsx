"use client";

import { useEffect, useState } from "react";
import { Alert, Badge } from "@mantine/core";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { SecretControl } from "@/app/_components/SecretControl";
import { LoadingText } from "@/app/_components/PageState";
import { generateAgentToken, getAgentToken, revealAgentToken, revokeAgentToken, type AgentCredentialStatus } from "../../lib/api";
import { useLocale, useT } from "@/app/_i18n/provider";
import { formatDate } from "@/shared/date";

export function TokenSection({ agentName, onSelect, selected }: { agentName: string; onSelect?: () => void; selected?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const [status, setStatus] = useState<AgentCredentialStatus | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    setStatus(null); setError(undefined);
    void getAgentToken(agentName).then(value => { if (current) setStatus(value); })
      .catch(error => { if (current) setError(error instanceof Error ? error.message : "Could not load agent token"); });
    return () => { current = false; };
  }, [agentName]);
  return <CollapsibleSection title={t("pset.apiToken")} onSelect={onSelect} selected={selected}
    selectLabel={onSelect ? t("pint.historyView") : undefined} badge={status &&
    <Badge color={status.configured ? "teal" : "gray"} radius="xl">
      {t(status.configured ? "secrets.configured" : "secrets.notConfigured")}
    </Badge>}>
    {error ? <Alert color="red">{error}</Alert> : !status ? <LoadingText /> : <SecretControl key={agentName}
      label={t("pset.apiToken")} showHeading={false} configured={status.configured} masked={status.masked}
      description={t("secrets.agentTokenHint")}
      details={status.createdAt ? t("secrets.createdAt", { date: formatDate(status.createdAt, locale) }) : undefined}
      onReveal={status.canIssue ? () => revealAgentToken(agentName) : undefined}
      generateDisabled={!status.canIssue}
      onGenerate={async () => {
        const result = await generateAgentToken(agentName);
        setStatus({ configured: true, masked: result.masked, createdAt: result.createdAt, canIssue: true });
        return result.token;
      }}
      onRevoke={async () => { await revokeAgentToken(agentName); setStatus({ configured: false, canIssue: status.canIssue }); }} />}
  </CollapsibleSection>;
}
