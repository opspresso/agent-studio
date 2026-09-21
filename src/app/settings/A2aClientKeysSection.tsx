"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Code, Group, Stack, Table, Text, TextInput } from "@mantine/core";
import { CopyButton } from "@/app/_components/CopyButton";
import { useConfirm } from "@/app/_components/useConfirm";
import { monoInput } from "@/app/_components/monoInput";
import { BADGE } from "@/app/_components/badgeColors";
import { toSlug } from "@/domain/naming";
// The shape this table renders, from the use case that answers with it — a
// type-only import, erased before the browser sees anything.
import type { A2aClientKeyView } from "@/application/a2a/clientKeyUseCases";
import { useT } from "@/app/_i18n/provider";
import { reportError } from "@/app/_lib/reportError";
import { createLatestOnly } from "@/app/_lib/latestOnly";

/**
 * Named inbound-A2A client keys, beside the shared key: each key names its
 * holder, so their runs are attributed (`a2a:{name}`) and bounded per client,
 * and one client can be revoked without rotating everyone else.
 */
export function A2aClientKeysSection() {
  const t = useT();
  const [items, setItems] = useState<A2aClientKeyView[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The plaintext of the key just issued or revealed — held in component state
  // only, so leaving the page hides it again.
  const [shown, setShown] = useState<{ name: string; key: string } | null>(null);
  const latestOnly = useRef(createLatestOnly()).current;

  async function refresh() {
    const isCurrent = latestOnly();
    try {
      // Throws on failure: a load that silently kept the stale list would render
      // "no client keys" for a fetch that never answered.
      const res = await fetch("/api/settings/a2a-keys");
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      const data = (await res.json()) as { items?: A2aClientKeyView[] };
      if (isCurrent()) setItems(data.items ?? []);
    } catch (error) {
      if (isCurrent()) throw error;
    }
  }

  useEffect(() => {
    refresh().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : "Failed to load client keys");
    });
  }, []);

  async function call(run: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      await refresh();
    } catch (err) {
      setError(reportError(err, "Request failed"));
    } finally {
      setBusy(false);
    }
  }

  function create() {
    void call(async () => {
      const res = await fetch("/api/settings/a2a-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: toSlug(name),
          ...(description.trim() ? { description: description.trim() } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { key?: string; error?: string };
      if (!res.ok || !data.key) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      setShown({ name: toSlug(name), key: data.key });
      setName("");
      setDescription("");
    });
  }

  function reveal(keyName: string) {
    void call(async () => {
      const res = await fetch(`/api/settings/a2a-keys/${keyName}/reveal`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { key?: string; error?: string };
      if (!res.ok || !data.key) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      setShown({ name: keyName, key: data.key });
    });
  }

  const { confirm, confirmModal } = useConfirm();

  async function revoke(keyName: string) {
    if (
      !(await confirm({
        title: t("settings.revokeTitle"),
        message: t("settings.revokeHint", { name: keyName }),
        confirmLabel: t("settings.revokeKey"),
      }))
    ) {
      return;
    }
    void call(async () => {
      const res = await fetch(`/api/settings/a2a-keys/${keyName}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      if (shown?.name === keyName) {
        setShown(null);
      }
    });
  }

  return (
    <Stack gap="xs">
      {confirmModal}
      <Group gap="xs">
        <Text fz="sm" fw={500}>
          {t("settings.clientKeys")}
        </Text>
        <Badge variant="light" color={BADGE.neutral} radius="xl">
          {items.length}
        </Badge>
      </Group>
      <Text fz="xs" c="dimmed">
        {t("settings.clientKeysHint")}
      </Text>
      {error && (
        <Alert color="red" variant="light" p="sm">
          {error}
        </Alert>
      )}
      {shown && (
        <Alert color="yellow" variant="light" p="sm">
          <Group gap="xs" wrap="nowrap">
            <Code style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{shown.key}</Code>
            <CopyButton text={shown.key} />
            <Button variant="default" size="compact-xs" onClick={() => setShown(null)}>
              {t("settings.hideKey")}
            </Button>
          </Group>
          <Text fz="xs" mt={4}>
            Key for <Code>{shown.name}</Code> — sent as <Code>X-A2A-Key</Code>.
          </Text>
        </Alert>
      )}
      {items.length > 0 && (
        <Table fz="sm" verticalSpacing={6}>
          <Table.Tbody>
            {items.map((item) => (
              <Table.Tr key={item.name}>
                <Table.Td ff="monospace">{item.name}</Table.Td>
                <Table.Td c="dimmed">{item.description ?? ""}</Table.Td>
                <Table.Td ff="monospace" c="dimmed">
                  {item.masked}
                </Table.Td>
                <Table.Td>
                  <Group gap={6} justify="flex-end" wrap="nowrap">
                    <Button
                      variant="default"
                      size="compact-xs"
                      onClick={() => reveal(item.name)}
                      disabled={busy}
                    >
                      {t("settings.revealKey")}
                    </Button>
                    <Button
                      variant="default"
                      size="compact-xs"
                      color="red"
                      onClick={() => revoke(item.name)}
                      disabled={busy}
                    >
                      {t("settings.revokeKey")}
                    </Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      <Group gap="xs" align="flex-end" wrap="wrap">
        <TextInput
          label={t("settings.clientName")}
          placeholder={t("settings.clientNamePlaceholder")}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          styles={monoInput}
          size="xs"
        />
        <TextInput
          label={t("registry.description")}
          placeholder={t("settings.optional")}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          size="xs"
          style={{ flex: 1, minWidth: 160 }}
        />
        <Button
          variant="default"
          size="compact-sm"
          onClick={create}
          loading={busy}
          disabled={!toSlug(name)}
        >
          {t("settings.issueKey")}
        </Button>
      </Group>
    </Stack>
  );
}
