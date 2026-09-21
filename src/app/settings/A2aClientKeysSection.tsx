"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Group, Stack, Text, TextInput } from "@mantine/core";
import type { A2aClientKeyView } from "@/application/a2a/clientKeyUseCases";
import { useT } from "@/app/_i18n/provider";
import { assertOk, jsonHeaders, readJson } from "@/app/_lib/httpClient";
import { reportError } from "@/app/_lib/reportError";
import { toSlug } from "@/domain/naming";
import { FormModal } from "@/app/_components/FormModal";
import { SecretControl } from "@/app/_components/SecretControl";
import { LoadingText } from "@/app/_components/PageState";

export function A2aClientKeysSection() {
  const t = useT();
  const [items, setItems] = useState<A2aClientKeyView[]>();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; key: string }>();
  useEffect(() => {
    let current = true;
    void fetch("/api/settings/a2a-keys").then(response => readJson<{ items: A2aClientKeyView[] }>(response))
      .then(result => { if (current) setItems(result.items); })
      .catch(error => { if (current) setError(error instanceof Error ? error.message : "Could not load client keys"); });
    return () => { current = false; };
  }, []);
  async function create() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await readJson<{ key: string; view: A2aClientKeyView }>(await fetch("/api/settings/a2a-keys", {
        method: "POST", headers: jsonHeaders, body: JSON.stringify({ name: toSlug(name), description: description.trim() || undefined }),
      }));
      setCreated({ name: result.view.name, key: result.key });
      setItems(items => [...(items ?? []), result.view].sort((a, b) => a.name.localeCompare(b.name)));
      setCreating(false); setName(""); setDescription("");
    } catch (error) { setError(reportError(error, "Could not create client key")); }
    finally { setBusy(false); }
  }
  return <Stack gap="md">
    <Group justify="space-between"><Group gap="xs"><Text fw={600}>{t("settings.clientKeys")}</Text>{items && <Badge>{items.length}</Badge>}</Group>
      <Button disabled={!items} onClick={() => { setCreating(true); setError(null); }}>{t("secrets.generate")}</Button></Group>
    <Text size="sm" c="dimmed">{t("settings.clientKeysHint")}</Text>
    {error && !creating && <Alert color="red">{error}</Alert>}
    {!items && !error && <LoadingText />}
    {items?.map(item => <Card key={item.name} padding="md"><SecretControl label={item.name} configured masked={item.masked} description={item.description}
      initialValue={created?.name === item.name ? created.key : undefined}
      onReveal={async () => (await readJson<{ key: string }>(await fetch(`/api/settings/a2a-keys/${item.name}/reveal`, { method: "POST" }))).key}
      onRevoke={async () => {
        await assertOk(await fetch(`/api/settings/a2a-keys/${item.name}`, { method: "DELETE" }));
        setItems(items => items?.filter(existing => existing.name !== item.name));
        if (created?.name === item.name) setCreated(undefined);
      }} /></Card>)}
    <FormModal opened={creating} onClose={() => setCreating(false)} title={t("settings.clientKeys")} error={error} submitting={busy}
      submitLabel={t("secrets.generate")} submitDisabled={!toSlug(name)} onSubmit={() => void create()}>
      <TextInput label={t("settings.clientName")} placeholder={t("settings.clientNamePlaceholder")} value={name} required onChange={event => setName(event.currentTarget.value)} />
      <TextInput label={t("registry.description")} value={description} onChange={event => setDescription(event.currentTarget.value)} />
    </FormModal>
  </Stack>;
}
