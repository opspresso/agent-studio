"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Button, Group, Select, Stack, Text } from "@mantine/core";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { useT } from "@/app/_i18n/provider";
import { jsonHeaders, readJson } from "@/app/_lib/httpClient";
import { reportError } from "@/app/_lib/reportError";
import type { ModelsCatalogResponse } from "@/app/api/models/catalog/route";

type Policy = ModelsCatalogResponse["unknownModelPolicy"]["value"];

export function ModelExecutionPolicySection({
  policy,
  onChanged,
}: {
  policy: ModelsCatalogResponse["unknownModelPolicy"];
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const [draft, setDraft] = useState<Policy>(policy.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setDraft(policy.value); }, [policy.value, policy.source]);

  async function save(value: Policy | "") {
    if (busy) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      await readJson(await fetch("/api/settings", {
        method: "PUT", headers: jsonHeaders, body: JSON.stringify({ unknownModelPolicy: value }),
      }));
      await onChanged();
      setSaved(true);
    } catch (error) {
      setError(reportError(error, t("modelAdmin.policyFailed")));
    } finally {
      setBusy(false);
    }
  }

  return <CollapsibleSection title={t("modelAdmin.executionPolicy")}>
    <Stack gap="sm">
      <Text size="sm" c="dimmed">{t("settings.hint.unknownModelPolicy")}</Text>
      {error && <Alert color="red">{error}</Alert>}
      <Select label={<Group gap="xs" component="span"><Text component="span" size="sm" fw={500}>{t("settings.field.unknownModelPolicy")}</Text>
        <Badge variant="light" color={policy.source === "override" ? "brand" : "gray"}>{t(`settings.source.${policy.source}`)}</Badge></Group>}
        value={draft} allowDeselect={false} disabled={busy}
        data={(["allow", "refuse"] as const).map(value => ({ value, label: t(`settings.unknownModelPolicy.${value}`) }))}
        onChange={value => { if (value === "allow" || value === "refuse") { setDraft(value); setSaved(false); } }} />
      <Group><Button onClick={() => void save(draft)} disabled={draft === policy.value} loading={busy}>{t("modelAdmin.save")}</Button>
        {policy.source === "override" && <Button variant="default" disabled={busy} onClick={() => void save("")}>{t("secrets.resetOverride")}</Button>}
        {saved && <Text size="sm" c="teal">{t("modelAdmin.saved")}</Text>}</Group>
    </Stack>
  </CollapsibleSection>;
}
