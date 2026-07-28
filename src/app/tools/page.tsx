"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toSlug } from "@/shared/slug";
import { createMcp, listMcps, type McpServer } from "./api";
import { HeaderRowsEditor, rowsToRecord, type HeaderRow } from "@/app/_components/HeaderRows";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Modal,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { monoInput } from "@/app/_components/monoInput";
import { useDisclosure } from "@mantine/hooks";
import { CardGrid } from "@/app/_components/CardGrid";
import { ManagedMcpModal } from "./_components/ManagedMcpModal";

export default function ToolsPage() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [registerOpened, register] = useDisclosure(false);
  const [managedOpened, managed] = useDisclosure(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setServers(await listMcps());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load MCP servers");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={1} fz="h2">
            Tools
          </Title>
          <Text fz="sm" c="dimmed" mt={4}>
            MCP servers that expose tools to agents over streamable HTTP.
          </Text>
        </div>
        <Group gap="xs">
          <Button variant="default" onClick={managed.open}>
            Run managed
          </Button>
          <Button onClick={register.open}>Register MCP</Button>
        </Group>
      </Group>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      <CardGrid loading={loading} empty={servers.length === 0} emptyText="No MCP servers yet.">
        {servers.map((server) => (
          <Card key={server.name} component={Link} href={`/tools/${server.name}`} h="100%">
            <Group gap="xs" wrap="wrap">
              <Text fw={500}>{server.name}</Text>
              {server.runtime === "managed" && <Badge>managed</Badge>}
              <CredentialBadges server={server} />
            </Group>
            <Text fz="sm" c="dimmed" mt={4} lineClamp={2}>
              {server.description || "No description"}
            </Text>
            <Text fz="xs" c="dimmed" mt="xs" truncate>
              {server.url}
            </Text>
          </Card>
        ))}
      </CardGrid>

      <ManagedMcpModal
        opened={managedOpened}
        onClose={managed.close}
        onCreated={() => {
          managed.close();
          void refresh();
        }}
      />

      <RegisterMcpModal
        opened={registerOpened}
        onClose={register.close}
        onCreated={() => {
          register.close();
          void refresh();
        }}
      />
    </Stack>
  );
}

/**
 * How an entry can be authenticated, at a glance.
 *
 * Both badges can appear at once, and the order is the order they are tried at
 * dispatch: a project's OAuth connection first, the entry's own headers as the
 * fallback for projects that have not connected. Neither badge means the entry
 * sends no credential at all, which is worth seeing on a list.
 */
function CredentialBadges({ server }: { server: McpServer }) {
  const headerCount = Object.keys(server.headers ?? {}).length;
  const badges: string[] = [
    ...(server.auth ? ["OAuth"] : []),
    ...(headerCount > 0 ? [`${headerCount} header${headerCount === 1 ? "" : "s"}`] : []),
  ];
  return (
    <>
      {(badges.length === 0 ? ["no credential"] : badges).map((badge) => (
        <Badge key={badge}>{badge}</Badge>
      ))}
    </>
  );
}

function RegisterMcpModal({
  opened,
  onClose,
  onCreated,
}: {
  opened: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [rows, setRows] = useState<HeaderRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createMcp({
        name,
        url,
        description: description || undefined,
        content: content || undefined,
        headers: rowsToRecord(rows),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to register MCP server");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Register MCP server" size="lg">
      <form onSubmit={submit}>
        <Stack gap="md">
          <TextInput
            label="Name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            onBlur={() => setName(toSlug(name))}
            placeholder="my-mcp"
            required
            description="Lowercase letters, digits, and hyphens only."
            inputWrapperOrder={["label", "input", "description", "error"]}
          />
          <TextInput
            label="URL"
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
            placeholder="https://example.com/mcp"
            type="url"
            required
          />
          <TextInput
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            placeholder="One-line summary shown to the model"
          />
          <Textarea
            label="Content (markdown)"
            value={content}
            onChange={(e) => setContent(e.currentTarget.value)}
            placeholder="Setup steps, caveats, links…"
            autosize
            minRows={6}
            maxRows={24}
            description="Operator notes for the console. Not sent to the model — only the description is."
            inputWrapperOrder={["label", "input", "description", "error"]}
            styles={monoInput}
          />

          <HeaderRowsEditor rows={rows} onChange={setRows} />

          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}

          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              Register
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
