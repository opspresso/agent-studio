"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Group, NumberInput, Stack, Table, Text, TextInput } from "@mantine/core";
import type { MemberTiersResponse } from "@/app/api/settings/member-tiers/route";
import { MAX_MEMBER_TIERS, MEMBER_TIER_ID, type MemberTierDefinition } from "@/domain/member/tiers";
import { SectionHeading } from "@/app/_components/SectionHeading";
import { LoadingText } from "@/app/_components/PageState";
import { useT } from "@/app/_i18n/provider";
import { jsonHeaders, readJson } from "@/app/_lib/httpClient";

type DraftTier = Omit<MemberTierDefinition, "monthlyCostCapUsd"> & { monthlyCostCapUsd: number | string | null };

export function MemberTierSettings() {
  const t = useT();
  const [view, setView] = useState<MemberTiersResponse | null>(null);
  const [tiers, setTiers] = useState<DraftTier[]>([]);
  const [name, setName] = useState("");
  const [newCap, setNewCap] = useState<number | string>("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let current = true;
    fetch("/api/settings/member-tiers").then(readJson<MemberTiersResponse>).then(next => {
      if (current) { setView(next); setTiers(next.tiers); setError(null); }
    }).catch(cause => { if (current) setError(cause instanceof Error ? cause.message : "Could not load member tiers"); });
    return () => { current = false; };
  }, [reload]);

  function change(next: DraftTier[]) { setTiers(next); setSaved(false); }
  async function save() {
    if (!view) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      const next = await readJson<MemberTiersResponse>(await fetch("/api/settings/member-tiers", {
        method: "PUT", headers: jsonHeaders, body: JSON.stringify({ revision: view.revision, tiers }),
      }));
      setView(next); setTiers(next.tiers); setSaved(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save member tiers"); }
    finally { setSaving(false); }
  }

  const dirty = view !== null && JSON.stringify(tiers) !== JSON.stringify(view.tiers);
  const valid = tiers.every(tier => tier.id === "admin" || typeof tier.monthlyCostCapUsd === "number" && Number.isFinite(tier.monthlyCostCapUsd) && tier.monthlyCostCapUsd >= 0);
  const canAdd = MEMBER_TIER_ID.test(name) && !tiers.some(tier => tier.id === name) && tiers.length < MAX_MEMBER_TIERS && typeof newCap === "number" && Number.isFinite(newCap) && newCap >= 0;

  return <Stack gap="lg" maw={860}>
    <SectionHeading title={t("settings.tiers.title")} description={t("settings.tiers.description")} />
    {error && <Alert color="red">{error}</Alert>}
    {!view && !error && <LoadingText />}
    {view && <Card>
      <Stack renderRoot={props => <fieldset {...props} disabled={saving} />} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        <Table.ScrollContainer minWidth={540}>
          <Table>
            <Table.Thead><Table.Tr>
              <Table.Th>{t("members.tier")}</Table.Th>
              <Table.Th>{t("settings.tiers.monthlyCap")}</Table.Th>
              <Table.Th>{t("settings.tiers.members")}</Table.Th>
              <Table.Th>{t("settings.tiers.actions")}</Table.Th>
            </Table.Tr></Table.Thead>
            <Table.Tbody>{tiers.map(tier => {
              const fixed = tier.id === "admin" || tier.id === "guest";
              const assigned = Object.hasOwn(view.assignedMembers, tier.id) ? view.assignedMembers[tier.id]! : 0;
              return <Table.Tr key={tier.id}>
                <Table.Td><Group gap="xs"><Text size="sm">{tier.id}</Text>{fixed && <Badge color="gray" size="xs">{t("settings.tiers.fixed")}</Badge>}</Group></Table.Td>
                <Table.Td>{tier.id === "admin" ? <Text size="sm">{t("profile.uncapped")}</Text> :
                  <NumberInput min={0} value={tier.monthlyCostCapUsd ?? ""} aria-label={t("settings.tiers.capFor", { tier: tier.id })}
                    onChange={value => change(tiers.map(entry => entry.id === tier.id ? { ...entry, monthlyCostCapUsd: value } : entry))} />}</Table.Td>
                <Table.Td>{assigned}</Table.Td>
                <Table.Td>{!fixed && <Button variant="subtle" color="red" size="compact-sm" disabled={assigned > 0}
                  aria-label={t("settings.tiers.removeNamed", { tier: tier.id })} onClick={() => change(tiers.filter(entry => entry.id !== tier.id))}>{t("settings.tiers.remove")}</Button>}</Table.Td>
              </Table.Tr>;
            })}</Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        <Text size="xs" c="dimmed">{t("settings.tiers.deleteHint")}</Text>
        <Group align="flex-end">
          <TextInput label={t("settings.tiers.newName")} description={t("settings.tiers.nameHint")} value={name} maxLength={40} onChange={event => setName(event.currentTarget.value)} />
          <NumberInput label={t("settings.tiers.monthlyCap")} min={0} value={newCap} onChange={setNewCap} />
          <Button variant="default" disabled={!canAdd} onClick={() => { change([...tiers, { id: name, monthlyCostCapUsd: newCap }]); setName(""); setNewCap(""); }}>{t("settings.tiers.add")}</Button>
        </Group>
        <Group><Button disabled={!dirty || !valid} loading={saving} onClick={() => void save()}>{t("modelAdmin.save")}</Button>
          {saved && <Text size="sm" c="teal">{t("modelAdmin.saved")}</Text>}</Group>
      </Stack>
    </Card>}
    {error && <Group><Button variant="default" disabled={saving} onClick={() => setReload(value => value + 1)}>{t("error.retry")}</Button></Group>}
  </Stack>;
}
