"use client";

import { SectionHeading } from "@/app/_components/SectionHeading";
import { Fragment, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Group, Select, Stack, TagsInput, Text, TextInput } from "@mantine/core";
import type { SettingKey, SettingsView } from "@/application/settings/settingsUseCases";
import { SecretInput } from "@/app/_components/SecretInput";
import { LoadingText } from "@/app/_components/PageState";
import { useT } from "@/app/_i18n/provider";
import { readJson } from "@/app/_lib/httpClient";
import { reportError } from "@/app/_lib/reportError";
import { parseList } from "@/shared/parseList";
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
        const data = await readJson<SettingsView>(res);
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
      const data = await readJson<SettingsView>(res);
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
          let control: React.ReactNode;
          if (field.type === "logo") control = <Select label={label} description={description} value={value} allowDeselect={false}
            data={view?.serviceLogos.map(logo => ({ value: logo, label: logo })) ?? []}
            onChange={value => { if (value) change(field.key, value); }} />;
          else if (field.type === "select") control = <Select label={label} description={description} value={value || field.fallback} allowDeselect={false}
            data={field.options.map(option => ({ value: option.value, label: t(option.label) }))}
            onChange={value => change(field.key, value ?? field.fallback)} />;
          else if (field.type === "emails" || field.type === "domains") control = <TagsInput label={label} description={description} placeholder={field.placeholder}
            value={parseList(value)} splitChars={[",", " "]} onChange={items => change(field.key, items.join(", "))} />;
          else if (field.type === "secret") control = <SecretInput label={label} description={description} value={value} storedValue={meta?.value} allowReset={meta?.source === "override"}
            onChange={value => change(field.key, value)} />;
          else if (field.type === "number") control = <TextInput label={label} description={description} value={value}
            type="number" min={field.min} max={field.max} step={field.step}
            onChange={event => change(field.key, event.currentTarget.value)} />;
          else control = <TextInput label={label} description={description} value={value} placeholder={field.placeholder}
            type={field.type === "url" ? "url" : "text"} pattern={field.type === "url" ? "https?://.+" : field.type === "repository" ? "[\\w.\\-]+/[\\w.\\-]+" : undefined}
            onChange={event => change(field.key, event.currentTarget.value)} />;
          return <Fragment key={field.key}>
            {field.group && <Text fw={600} size="sm" mt="sm">{t(field.group)}</Text>}
            {control}
          </Fragment>;
        })}
        <Group><Button type="submit" loading={saving} disabled={!dirty}>{t("modelAdmin.save")}</Button>{saved && <Text size="sm" c="teal">{t("modelAdmin.saved")}</Text>}</Group>
      </Stack>
    </form>
    <Text size="xs" c="dimmed" mt="md">{t("settings.overrideHint")}</Text></Card>
  </Stack>;
}
