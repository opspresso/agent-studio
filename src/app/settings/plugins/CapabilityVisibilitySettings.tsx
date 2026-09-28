"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Checkbox, Group, Stack, Table, Tabs, Text, TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import type { CapabilityVisibilityView } from "@/application/plugin/capabilityVisibility";
import { CAPABILITY_KINDS, capabilityUsageChanges, emptyCapabilityVisibility, isCapabilityVisible, type CapabilityVisibility } from "@/domain/plugin/visibility";
import { useT } from "@/app/_i18n/provider";
import { LoadingText } from "@/app/_components/PageState";
import { SectionHeading } from "@/app/_components/SectionHeading";
import { readJson } from "@/app/_lib/httpClient";
import { reportError } from "@/app/_lib/reportError";
import { matchesFilter } from "@/app/_components/CatalogSearch";

const ENDPOINT = "/api/settings/plugins/visibility";

export function CapabilityVisibilitySettings() {
  const t = useT();
  const [view, setView] = useState<CapabilityVisibilityView | null>(null);
  const [hidden, setHidden] = useState<CapabilityVisibility>(emptyCapabilityVisibility);
  const [kind, setKind] = useState<keyof CapabilityVisibility>("plugins");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await readJson<CapabilityVisibilityView>(await fetch(ENDPOINT));
        if (!cancelled) { setView(next); setHidden(next.hidden); }
      } catch (error) {
        if (!cancelled) setError(reportError(error, "Failed to load capability visibility"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  const changes = view ? capabilityUsageChanges(view.hidden, hidden) : [];
  const dirty = changes.length > 0;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true); setError(null); setSaved(false);
    try {
      const next = await readJson<CapabilityVisibilityView>(await fetch(ENDPOINT, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changes }),
      }));
      setView(next); setHidden(next.hidden); setSaved(true);
    } catch (error) {
      setError(reportError(error, "Failed to save capability visibility"));
    } finally {
      setSaving(false);
    }
  }

  // Keep saved names selectable even if a subsequent sync removed their registry rows.
  const registeredNames = new Set(view?.[kind].map(item => item.name));
  const items = view ? [...view[kind], ...[...new Set([...view.hidden[kind], ...hidden[kind]])].filter(name => !registeredNames.has(name))
    .map(name => ({ name, description: "", plugin: undefined }))]
    .filter(item => matchesFilter(filter, item.name, item.description, item.plugin)) : [];

  return <Stack gap="lg">
    <SectionHeading title={t("settings.visibility.title")} description={t("settings.visibility.hint")} />
    {error && <Alert color="red">{error}</Alert>}
    {loading ? <LoadingText /> : view ? <Card component="form" onSubmit={save}>
      <Stack renderRoot={props => <fieldset {...props} disabled={saving} />} gap="md"
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <Tabs value={kind} onChange={value => {
          if (CAPABILITY_KINDS.some(key => key === value)) { setKind(value as keyof CapabilityVisibility); setFilter(""); }
        }}>
          <Tabs.List aria-label={t("settings.visibility.kinds")}>{CAPABILITY_KINDS.map(key => <Tabs.Tab key={key} value={key}>{t(`nav.${key}`)}</Tabs.Tab>)}</Tabs.List>
        </Tabs>
        <TextInput aria-label={t("settings.visibility.filter")} placeholder={t("settings.visibility.filter")}
          leftSection={<IconSearch size={16} />} value={filter} onChange={event => setFilter(event.currentTarget.value)} />
        {items.length === 0 ? <Text size="sm" c="dimmed">{t("catalog.noResults")}</Text> : <Table>
          <Table.Thead><Table.Tr><Table.Th>{t("settings.visibility.enabled")}</Table.Th><Table.Th>{t("settings.visibility.capability")}</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>{items.map(item => {
            const inherited = kind !== "plugins" && item.plugin !== undefined && !isCapabilityVisible(hidden, "plugins", item.plugin);
            const checked = !inherited && isCapabilityVisible(hidden, kind, item.name);
            return <Table.Tr key={item.name}>
              <Table.Td w={70}><Checkbox aria-label={t("settings.visibility.use", { name: item.name })}
                checked={checked} disabled={inherited} onChange={event => {
                  const checked = event.currentTarget.checked;
                  setHidden(previous => ({ ...previous, [kind]: checked
                    ? previous[kind].filter(name => name !== item.name) : [...new Set([...previous[kind], item.name])].sort() }));
                  setSaved(false);
                }} /></Table.Td>
              <Table.Td><Group gap="xs"><Text size="sm" fw={500} style={{ overflowWrap: "anywhere" }}>{item.name}</Text>
                {inherited && <Badge color="gray" variant="light">{t("settings.visibility.inherited", { name: item.plugin! })}</Badge>}
              </Group>{item.description && <Text size="xs" c="dimmed" lineClamp={2}>{item.description}</Text>}</Table.Td>
            </Table.Tr>;
          })}</Table.Tbody>
        </Table>}
        <Group><Button type="submit" loading={saving} disabled={!dirty}>{t("modelAdmin.save")}</Button>
          {saved && <Text size="sm" c="teal">{t("modelAdmin.saved")}</Text>}</Group>
      </Stack>
    </Card> : <Group><Button variant="default" onClick={() => {
      setLoading(true); setError(null); setReloadKey(key => key + 1);
    }}>{t("error.retry")}</Button></Group>}
  </Stack>;
}
