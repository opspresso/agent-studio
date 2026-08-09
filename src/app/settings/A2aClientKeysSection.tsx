"use client";

import { useEffect, useState } from "react";
import { Alert, Badge, Button, Code, Group, Stack, Table, Text, TextInput } from "@mantine/core";
import { CopyButton } from "@/app/_components/CopyButton";
import { monoInput } from "@/app/_components/monoInput";
import { BADGE } from "@/app/_components/badgeColors";
import { toSlug } from "@/shared/slug";

interface ClientKeyView {
  name: string;
  description?: string;
  masked: string;
  createdAt: string;
}

/**
 * Named inbound-A2A client keys, beside the shared key: each key names its
 * holder, so their runs are attributed (`a2a:{name}`) and bounded per client,
 * and one client can be revoked without rotating everyone else.
 */
export function A2aClientKeysSection() {
  const [items, setItems] = useState<ClientKeyView[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The plaintext of the key just issued or revealed — held in component state
  // only, so leaving the page hides it again.
  const [shown, setShown] = useState<{ name: string; key: string } | null>(null);

  async function refresh() {
    // Throws on failure: a load that silently kept the stale list would render
    // "no client keys" for a fetch that never answered.
    const res = await fetch("/api/settings/a2a-keys");
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? `Request failed (${res.status})`);
    }
    const data = (await res.json()) as { items?: ClientKeyView[] };
    setItems(data.items ?? []);
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
      setError(err instanceof Error ? err.message : "Request failed");
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

  function revoke(keyName: string) {
    if (!confirm(`Revoke the client key "${keyName}"? Its runs stop authenticating immediately.`)) {
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
      <Group gap="xs">
        <Text fz="sm" fw={500}>
          Client keys
        </Text>
        <Badge variant="light" color={BADGE.neutral} radius="xl">
          {items.length}
        </Badge>
      </Group>
      <Text fz="xs" c="dimmed">
        A client key works like the shared key but names its caller: runs are attributed to{" "}
        <Code>a2a:&#123;name&#125;</Code>, the per-caller concurrency limit applies per client,
        and revoking one client does not rotate everyone else.
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
              Hide
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
                      Reveal
                    </Button>
                    <Button
                      variant="default"
                      size="compact-xs"
                      color="red"
                      onClick={() => revoke(item.name)}
                      disabled={busy}
                    >
                      Revoke
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
          label="Client name"
          placeholder="partner-batch"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          styles={monoInput}
          size="xs"
        />
        <TextInput
          label="Description"
          placeholder="optional"
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
          Issue key
        </Button>
      </Group>
    </Stack>
  );
}
