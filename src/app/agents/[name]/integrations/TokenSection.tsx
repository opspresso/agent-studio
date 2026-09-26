"use client";

import { useEffect, useState } from "react";
import { Alert, Badge } from "@mantine/core";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { SecretControl } from "@/app/_components/SecretControl";
import { LoadingText } from "@/app/_components/PageState";
import { generateAgentToken, getAgentToken, revealAgentToken, revokeAgentToken, type ApiTokenStatus } from "../../lib/api";
import { useLocale, useT } from "@/app/_i18n/provider";
import { formatDate } from "@/shared/date";

export function TokenSection({ agentName }: { agentName: string }) {
  const t = useT();
  const locale = useLocale();
  const [status, setStatus] = useState<ApiTokenStatus | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    setStatus(null); setError(undefined);
    void getAgentToken(agentName).then(value => { if (current) setStatus(value); })
      .catch(error => { if (current) setError(error instanceof Error ? error.message : "Could not load agent token"); });
    return () => { current = false; };
  }, [agentName]);
  return <CollapsibleSection title={t("pset.apiToken")} badge={status &&
    <Badge color={status.configured ? "teal" : "gray"} radius="xl">
      {t(status.configured ? "secrets.configured" : "secrets.notConfigured")}
    </Badge>}>
    {error ? <Alert color="red">{error}</Alert> : !status ? <LoadingText /> : <SecretControl key={agentName}
      label={t("pset.apiToken")} showHeading={false} configured={status.configured} masked={status.masked}
      description={t("secrets.agentTokenHint")}
      details={status.revealable === false ? t("secrets.legacyHint") : status.createdAt ? t("secrets.createdAt", { date: formatDate(status.createdAt, locale) }) : undefined}
      onReveal={status.revealable === false ? undefined : () => revealAgentToken(agentName)}
      onGenerate={async () => {
        const result = await generateAgentToken(agentName);
        setStatus({ configured: true, masked: result.masked, createdAt: result.createdAt, revealable: true });
        return result.token;
      }}
      onRevoke={async () => { await revokeAgentToken(agentName); setStatus({ configured: false }); }} />}
  </CollapsibleSection>;
}
