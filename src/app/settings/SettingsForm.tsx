"use client";

import { SectionHeading } from "@/app/_components/SectionHeading";
import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Group, Select, Stack, TagsInput, Text, TextInput } from "@mantine/core";
import type { SettingKey, SettingsView } from "@/application/settings/settingsUseCases";
import { SecretInput } from "@/app/_components/SecretInput";
import { SharedA2aKeySection } from "./SharedA2aKeySection";
import { LoadingText } from "@/app/_components/PageState";
import { useT } from "@/app/_i18n/provider";
import { reportError } from "@/app/_lib/reportError";
import { parseList } from "@/shared/parseList";
import { A2aClientKeysSection } from "./A2aClientKeysSection";
import { SETTINGS_FIELDS, settingsPatch, type SettingsSection } from "./fields";

export function SettingsForm({ section }: { section: SettingsSection }) {
  const t = useT();
  const [view, setView] = useState<SettingsView | null>(null);
  const [values, setValues] = useState<Partial<Record<SettingKey, string>>>({});
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  function applyView(next: SettingsView) {
    setView(next);
    setValues(Object.fromEntries(Object.entries(next.fields).map(([k, f]) => [k, f.value])));
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/settings");
        if (res.status === 403) {
          if (!cancelled) {
            setForbidden(true);
          }
          return;
        }
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`);
        }
        const data = (await res.json()) as SettingsView;
        if (!cancelled) {
          applyView(data);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load settings");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (view === null) {
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settingsPatch(section, values, view)),
      });
      const data = (await res.json().catch(() => ({}))) as SettingsView & { error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      applyView(data);
      setSaved(true);
    } catch (err) {
      setError(reportError(err, "Failed to save"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <LoadingText />;
  }

  if (forbidden) {
    return (
      <Alert variant="light" color="gray" maw={640}>
        {t("settings.adminOnly")}
      </Alert>
    );
  }

  const dirty = view !== null && Object.keys(settingsPatch(section, values, view)).length > 0;
  const change = (key: SettingKey, value: string) => { setValues(previous => ({ ...previous, [key]: value })); setSaved(false); };
  return <Stack gap="lg" maw={860}>
    <SectionHeading title={t(`settings.tab.${section}`)} description={t(`settings.section.${section}`)} />
    {error && <Alert color="red">{error}</Alert>}
    <Card><form onSubmit={save}>
      <Stack renderRoot={props => <fieldset {...props} disabled={!view || saving} />} gap="lg" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        {SETTINGS_FIELDS[section].map(field => {
          const meta = view?.fields[field.key];
          const label = <Group component="span" gap="xs"><Text component="span" size="sm" fw={500}>{t(field.label)}</Text>
            <Badge variant="light" color={meta?.source === "override" ? "brand" : "gray"}>{t(`settings.source.${meta?.source ?? "unset"}`)}</Badge></Group>;
          const description = field.hint ? t(field.hint) : undefined;
          const value = values[field.key] ?? "";
          if (field.type === "select") return <Select key={field.key} label={label} description={description} value={value || field.fallback} allowDeselect={false}
            data={field.options.map(option => ({ value: option.value, label: t(option.label) }))}
            onChange={value => change(field.key, value ?? field.fallback)} />;
          if (field.type === "emails" || field.type === "domains") return <TagsInput key={field.key} label={label} description={description} placeholder={field.placeholder}
            value={parseList(value)} splitChars={[",", " "]} onChange={items => change(field.key, items.join(", "))} />;
          if (field.type === "secret") return <SecretInput key={field.key} label={label} description={description} value={value} storedValue={meta?.value} allowReset={meta?.source === "override"}
            onChange={value => change(field.key, value)} />;
          return <TextInput key={field.key} label={label} description={description} value={value} placeholder={field.placeholder}
            type={field.type === "url" ? "url" : "text"} pattern={field.type === "url" ? "https?://.+" : field.type === "repository" ? "[\\w.\\-]+/[\\w.\\-]+" : undefined}
            onChange={event => change(field.key, event.currentTarget.value)} />;
        })}
        <Group><Button type="submit" loading={saving} disabled={!dirty}>{t("modelAdmin.save")}</Button>{saved && <Text size="sm" c="teal">{t("modelAdmin.saved")}</Text>}</Group>
      </Stack>
    </form>
    <Text size="xs" c="dimmed" mt="md">{t("settings.overrideHint")}</Text></Card>
    {section === "keys" && view && <>
      <SharedA2aKeySection field={view.fields.a2aApiKey} disabled={saving} onChanged={next => {
        setView(current => current ? { ...current, fields: { ...current.fields, a2aApiKey: next.fields.a2aApiKey }, updatedAt: next.updatedAt } : next);
      }} />
      <Card><A2aClientKeysSection /></Card>
    </>}
  </Stack>;
}
