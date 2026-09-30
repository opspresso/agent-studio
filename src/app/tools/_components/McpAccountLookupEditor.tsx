"use client";

import { useState } from "react";
import { Button, Group, Select, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { readMcpAccountLookup, type McpAccountLookup } from "@/domain/mcp/account";
import { useT } from "@/app/_i18n/provider";

export function McpAccountLookupEditor({ value, userInfoEndpoint, disabled, onSave }: {
  value?: McpAccountLookup;
  userInfoEndpoint?: string;
  disabled: boolean;
  onSave: (value: McpAccountLookup | null) => Promise<void>;
}) {
  const t = useT();
  const [mode, setMode] = useState<string>(value?.kind ?? "auto");
  const [endpoint, setEndpoint] = useState(value?.kind === "http" ? value.endpoint : "");
  const [toolName, setToolName] = useState(value?.kind === "mcp" ? value.toolName : "");
  const [args, setArgs] = useState(value?.kind === "mcp" ? JSON.stringify(value.arguments, null, 2) : "{}");
  const [labelPath, setLabelPath] = useState(value && value.kind !== "none" ? value.labelPath : "/email");
  const [scopes, setScopes] = useState(value?.kind === "http" ? (value.scopes ?? []).join(" ") : "");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function save() {
    setError(undefined);
    setSaving(true);
    try {
      const draft: unknown = mode === "none" ? { kind: "none" }
        : mode === "http" ? { kind: "http", endpoint, labelPath, scopes: scopes.split(/\s+/).filter(Boolean) }
        : mode === "mcp" ? { kind: "mcp", toolName, arguments: JSON.parse(args), labelPath } : undefined;
      const parsed = mode === "auto" ? null : readMcpAccountLookup(draft);
      if (parsed === undefined) throw new Error("Invalid account lookup settings. Check the endpoint, tool arguments and JSON Pointer.");
      await onSave(parsed);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Failed to save account lookup settings");
    } finally { setSaving(false); }
  }

  return <Stack gap="xs">
    <Text fw={600}>{t("mcpAccount.title")}</Text>
    <Text size="sm" c="dimmed">{t("mcpAccount.hint")}</Text>
    <Select label={t("mcpAccount.method")} value={mode} onChange={next => setMode(next ?? "auto")} disabled={disabled || saving} data={[
      { value: "auto", label: t("mcpAccount.auto") }, { value: "http", label: t("mcpAccount.http") },
      { value: "mcp", label: t("mcpAccount.mcp") }, { value: "none", label: t("mcpAccount.none") },
    ]} />
    {mode === "auto" && userInfoEndpoint && <Text size="sm" c="dimmed" style={{ overflowWrap: "anywhere" }}>{t("mcpAccount.discovered", { endpoint: userInfoEndpoint })}</Text>}
    {mode === "http" && <>
      <TextInput label={t("mcpAccount.endpoint")} value={endpoint} onChange={event => setEndpoint(event.currentTarget.value)} disabled={disabled || saving} placeholder="https://identity.example.com/userinfo" />
      <TextInput label={t("mcpAccount.scopes")} value={scopes} onChange={event => setScopes(event.currentTarget.value)} disabled={disabled || saving} description={t("mcpAccount.scopesHint")} />
    </>}
    {mode === "mcp" && <>
      <TextInput label={t("mcpAccount.tool")} value={toolName} onChange={event => setToolName(event.currentTarget.value)} disabled={disabled || saving} description={t("mcpAccount.readOnly")} />
      <Textarea label={t("mcpAccount.arguments")} description={t("mcpAccount.argumentsHint")} value={args} onChange={event => setArgs(event.currentTarget.value)} disabled={disabled || saving} autosize minRows={2} />
    </>}
    {(mode === "http" || mode === "mcp") && <TextInput label={t("mcpAccount.path")} description={t("mcpAccount.pathHint")} value={labelPath} onChange={event => setLabelPath(event.currentTarget.value)} disabled={disabled || saving} placeholder="/data/email" />}
    {error && <Text size="sm" c="red">{error}</Text>}
    <Group justify="flex-end"><Button variant="default" disabled={disabled} loading={saving} onClick={() => void save()}>{t("mcpAccount.save")}</Button></Group>
  </Stack>;
}
