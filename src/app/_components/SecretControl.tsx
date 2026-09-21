"use client";

import { useState } from "react";
import { Alert, Badge, Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { reportError } from "@/app/_lib/reportError";
import { compactSecretMask } from "@/app/_lib/secretMask";
import { CopyButton } from "./CopyButton";
import { SecretInput } from "./SecretInput";
import { monoInput } from "./monoInput";
import { useConfirm } from "./useConfirm";

/** App-issued credentials share presentation and lifecycle controls; adapters retain authorization and storage. */
export function SecretControl({ label, configured, masked, description, details, initialValue, disabled, generateDisabled,
  onReveal, onGenerate, onRevoke, onSave, onReset }: {
  label: string;
  configured: boolean;
  masked?: string;
  description?: React.ReactNode;
  details?: React.ReactNode;
  initialValue?: string;
  disabled?: boolean;
  generateDisabled?: boolean;
  onReveal?: () => Promise<string>;
  onGenerate?: () => Promise<string>;
  onRevoke?: () => Promise<void>;
  onSave?: (value: string) => Promise<void>;
  onReset?: () => Promise<void>;
}) {
  const t = useT();
  const [raw, setRaw] = useState<string | null>(initialValue ?? null);
  const [operation, setOperation] = useState<"show" | "generate" | "revoke" | "save" | "reset" | null>(null);
  const busy = operation !== null;
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const { confirm, confirmModal } = useConfirm();
  const unavailable = disabled || busy;

  async function run(kind: NonNullable<typeof operation>, action: () => Promise<void>) {
    if (unavailable) return;
    setOperation(kind); setError(undefined);
    try { await action(); }
    catch (error) { setError(reportError(error, "Credential operation failed")); }
    finally { setOperation(null); }
  }
  async function generate() {
    if (!onGenerate || unavailable || generateDisabled) return;
    if (configured && !await confirm({ title: t("secrets.regenerateTitle", { name: label }), message: t("secrets.regenerateHint"), confirmLabel: t("secrets.regenerate") })) return;
    await run("generate", async () => { setRaw(null); setRaw(await onGenerate()); setEditing(false); setDraft(""); });
  }
  async function revoke() {
    if (!onRevoke || unavailable) return;
    if (!await confirm({ title: t("secrets.revokeTitle", { name: label }), message: t("secrets.revokeHint"), confirmLabel: t("secrets.revoke") })) return;
    await run("revoke", async () => { await onRevoke(); setRaw(null); setEditing(false); setDraft(""); });
  }
  async function reset() {
    if (!onReset || unavailable) return;
    if (!await confirm({ title: t("secrets.resetOverride"), message: t("secrets.resetConfirm"), confirmLabel: t("secrets.resetOverride") })) return;
    await run("reset", async () => { await onReset(); setRaw(null); setEditing(false); setDraft(""); });
  }
  async function save() {
    if (!onSave || unavailable || !draft.trim()) return;
    if (configured && !await confirm({ title: t("secrets.replaceTitle", { name: label }), message: t("secrets.regenerateHint"), confirmLabel: t("secrets.save") })) return;
    await run("save", async () => { await onSave(draft); setDraft(""); setEditing(false); setRaw(null); });
  }
  return <Stack gap="sm" role="group" aria-label={label}>
    {confirmModal}
    <Group justify="space-between" gap="xs"><Text size="sm" fw={600}>{label}</Text><Badge color={configured ? "teal" : "gray"}>{t(configured ? "secrets.configured" : "secrets.notConfigured")}</Badge></Group>
    {description && <Text size="sm" c="dimmed">{description}</Text>}
    <TextInput readOnly aria-label={label} value={raw ?? (configured ? compactSecretMask(masked || "••••••••") : "")} placeholder={t("secrets.notConfigured")} styles={monoInput} />
    {raw && <Text size="xs" c="dimmed">{t("secrets.visibleHint")}</Text>}
    {details && <Text size="xs" c="dimmed">{details}</Text>}
    <Group gap="xs" wrap="wrap">
      {raw ? <Button variant="default" disabled={unavailable} onClick={() => setRaw(null)}>{t("secrets.hide")}</Button>
        : configured && onReveal && <Button variant="default" disabled={unavailable} loading={operation === "show"} onClick={() => void run("show", async () => setRaw(await onReveal()))}>{t("secrets.show")}</Button>}
      {raw && <CopyButton text={raw} size="sm" disabled={unavailable} />}
      {onGenerate && <Button variant={configured ? "default" : "filled"} loading={operation === "generate"} disabled={unavailable || generateDisabled} onClick={() => void generate()}>{t(configured ? "secrets.regenerate" : "secrets.generate")}</Button>}
      {onSave && <Button variant="default" disabled={unavailable} onClick={() => { setRaw(null); setEditing(!editing); setDraft(""); }}>{t(editing ? "common.cancel" : "secrets.enter")}</Button>}
      {onReset && <Button variant="default" disabled={unavailable} loading={operation === "reset"} onClick={() => void reset()}>{t("secrets.resetOverride")}</Button>}
      {configured && onRevoke && <Button variant="default" color="red" disabled={unavailable} loading={operation === "revoke"} onClick={() => void revoke()}>{t("secrets.revoke")}</Button>}
    </Group>
    {editing && onSave && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <Stack gap="sm">
        <SecretInput label={t("secrets.newValue")} value={draft} onChange={setDraft} disabled={unavailable} />
        <Group><Button type="submit" loading={operation === "save"} disabled={!draft.trim() || unavailable}>{t("secrets.save")}</Button></Group>
      </Stack>
    </form>}
    {error && <Alert color="red">{error}</Alert>}
  </Stack>;
}
