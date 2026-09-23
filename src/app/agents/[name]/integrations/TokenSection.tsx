"use client";

import { useEffect, useState } from "react";
import { Alert } from "@mantine/core";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { SecretControl } from "@/app/_components/SecretControl";
import { LoadingText } from "@/app/_components/PageState";
import { generateProjectToken, getProjectToken, revealProjectToken, revokeProjectToken, type ApiTokenStatus } from "../../lib/api";
import { useLocale, useT } from "@/app/_i18n/provider";
import { formatDate } from "@/shared/date";

export function TokenSection({ projectName }: { projectName: string }) {
  const t = useT();
  const locale = useLocale();
  const [status, setStatus] = useState<ApiTokenStatus | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    setStatus(null); setError(undefined);
    void getProjectToken(projectName).then(value => { if (current) setStatus(value); })
      .catch(error => { if (current) setError(error instanceof Error ? error.message : "Could not load project token"); });
    return () => { current = false; };
  }, [projectName]);
  return <CollapsibleSection title={t("pset.apiToken")}>
    {error ? <Alert color="red">{error}</Alert> : !status ? <LoadingText /> : <SecretControl key={projectName}
      label={t("pset.apiToken")} configured={status.configured} masked={status.masked}
      description={t("secrets.projectTokenHint")}
      details={status.revealable === false ? t("secrets.legacyHint") : status.createdAt ? t("secrets.createdAt", { date: formatDate(status.createdAt, locale) }) : undefined}
      onReveal={status.revealable === false ? undefined : () => revealProjectToken(projectName)}
      onGenerate={async () => {
        const result = await generateProjectToken(projectName);
        setStatus({ configured: true, masked: result.masked, createdAt: result.createdAt, revealable: true });
        return result.token;
      }}
      onRevoke={async () => { await revokeProjectToken(projectName); setStatus({ configured: false }); }} />}
  </CollapsibleSection>;
}
