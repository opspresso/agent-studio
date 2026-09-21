"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Code, Group, PasswordInput, Select, Stack, TagsInput, Text, TextInput, Title } from "@mantine/core";
import type { SettingKey, SettingsView } from "@/application/settings/settingsUseCases";
import { CopyButton } from "@/app/_components/CopyButton";
import { LoadingText } from "@/app/_components/PageState";
import { useConfirm } from "@/app/_components/useConfirm";
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
  /** Raw A2A key, held only until the page is left — it is masked from then on. */
  // The plaintext A2A key, either just issued or read back on request. Held in
  // component state only, so leaving the page hides it again.
  const [a2aKeyShown, setA2aKeyShown] = useState<string | null>(null);
  const [a2aKeyFreshlyIssued, setA2aKeyFreshlyIssued] = useState(false);
  const [issuingA2aKey, setIssuingA2aKey] = useState(false);

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

  const { confirm, confirmModal } = useConfirm();

  async function issueA2aKey(replacing: boolean) {
    if (
      replacing &&
      !(await confirm({
        title: t("settings.rotateTitle"),
        message: t("settings.rotateHint"),
        confirmLabel: t("settings.generate"),
      }))
    ) {
      return;
    }
    setIssuingA2aKey(true);
    setError(null);
    setA2aKeyShown(null);
    try {
      const res = await fetch("/api/settings/a2a-key", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        key?: string;
        view?: SettingsView;
        error?: string;
      };
      if (!res.ok || !data.key || !data.view) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      setA2aKeyShown(data.key);
      setA2aKeyFreshlyIssued(true);
      const next = data.view;
      setView(next);
      setValues(previous => ({ ...previous, a2aApiKey: next.fields.a2aApiKey.value }));
    } catch (err) {
      setError(reportError(err, "Failed to generate A2A key"));
    } finally {
      setIssuingA2aKey(false);
    }
  }

  /** Read the effective key back in plaintext (stored override decrypted, or env). */
  async function revealA2aKey() {
    setIssuingA2aKey(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/a2a-key/reveal", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { key?: string; error?: string };
      if (!res.ok || !data.key) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      setA2aKeyShown(data.key);
      setA2aKeyFreshlyIssued(false);
    } catch (err) {
      setError(reportError(err, "Failed to reveal A2A key"));
    } finally {
      setIssuingA2aKey(false);
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
    <div><Title order={2} size="h3">{t(`settings.tab.${section}`)}</Title><Text c="dimmed" size="sm" mt={4}>{t(`settings.section.${section}`)}</Text></div>
    {confirmModal}
    {error && <Alert color="red">{error}</Alert>}
    <form onSubmit={save}>
      <Stack renderRoot={props => <fieldset {...props} disabled={!view || saving || issuingA2aKey} />} gap="lg" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        {SETTINGS_FIELDS[section].map(field => {
          const meta = view?.fields[field.key];
          const label = <Group component="span" gap="xs"><Text component="span" size="sm" fw={500}>{t(field.label)}</Text>
            <Badge variant="light" color={meta?.source === "override" ? "brand" : "gray"}>{t(`settings.source.${meta?.source ?? "unset"}`)}</Badge></Group>;
          const description = field.hint ? t(field.hint) : undefined;
          const value = values[field.key] ?? "";
          if (field.type === "artifactAccess") return <Select key={field.key} label={label} description={description} value={value || "authenticated"} allowDeselect={false}
            data={["authenticated", "proxied", "public"].map(value => ({ value, label: t(`settings.artifactAccess.${value as "authenticated" | "proxied" | "public"}`) }))}
            onChange={value => change(field.key, value ?? "authenticated")} />;
          if (field.type === "emails" || field.type === "domains") return <TagsInput key={field.key} label={label} description={description} placeholder={field.placeholder}
            value={parseList(value)} splitChars={[",", " "]} onChange={items => change(field.key, items.join(", "))} />;
          if (field.type === "secret") return <PasswordInput key={field.key} label={label} description={description} value={value} autoComplete="new-password"
            onFocus={event => event.currentTarget.select()} onChange={event => change(field.key, event.currentTarget.value)} />;
          return <TextInput key={field.key} label={label} description={description} value={value} placeholder={field.placeholder}
            type={field.type === "url" ? "url" : "text"} pattern={field.type === "url" ? "https?://.+" : field.type === "repository" ? "[\\w.\\-]+/[\\w.\\-]+" : undefined}
            onChange={event => change(field.key, event.currentTarget.value)} />;
        })}
        <Group><Button type="submit" loading={saving} disabled={!dirty}>{t("modelAdmin.save")}</Button>{saved && <Text size="sm" c="teal">{t("modelAdmin.saved")}</Text>}</Group>
      </Stack>
    </form>
    <Text size="xs" c="dimmed">{t("settings.overrideHint")}</Text>
    {section === "keys" && <>
      <Card><Stack gap="sm">
        <Title order={3} size="h4">{t("settings.sharedA2aKey")}</Title>
        {a2aKeyShown && <Alert color="yellow"><Group wrap="nowrap"><Code style={{ overflowWrap: "anywhere", flex: 1 }}>{a2aKeyShown}</Code>
          <CopyButton text={a2aKeyShown} /><Button variant="subtle" onClick={() => setA2aKeyShown(null)}>{t("settings.hideKey")}</Button></Group>
          {a2aKeyFreshlyIssued && <Text size="xs" mt="xs">{t("settings.keyIssued")}</Text>}</Alert>}
        <Group>
          <Button variant="default" loading={issuingA2aKey} disabled={!view || saving} onClick={() => void issueA2aKey(view?.fields.a2aApiKey.source !== "unset")}>
            {t(view?.fields.a2aApiKey.source === "unset" ? "settings.generate" : "settings.regenerate")}</Button>
          {view?.fields.a2aApiKey.source !== "unset" && !a2aKeyShown && <Button variant="subtle" disabled={!view || issuingA2aKey || saving} onClick={() => void revealA2aKey()}>{t("settings.revealKey")}</Button>}
        </Group>
      </Stack></Card>
      <Card><A2aClientKeysSection /></Card>
    </>}
  </Stack>;
}
