"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toSlug } from "@/shared/slug";
import {
  createMcp,
  listMcps,
  syncTools,
  type McpServer,
  type SkippedTool,
  type ToolSyncResult,
} from "./api";
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
import { CredentialBadges } from "./_components/CredentialBadges";
import { MCP_RUNTIME_COLOR } from "@/app/_components/badgeColors";

export default function ToolsPage() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [registerOpened, register] = useDisclosure(false);
  const [managedOpened, managed] = useDisclosure(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<ToolSyncResult | null>(null);

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
          <Button
            variant="default"
            loading={syncing}
            onClick={async () => {
              setSyncing(true);
              setSyncResult(null);
              setError(null);
              try {
                setSyncResult(await syncTools());
                await refresh();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Sync failed");
              } finally {
                setSyncing(false);
              }
            }}
          >
            Sync from GitHub
          </Button>
          <Button variant="default" onClick={managed.open}>
            Run managed
          </Button>
          <Button onClick={register.open}>Register MCP</Button>
        </Group>
      </Group>

      {syncResult && <SyncSummary result={syncResult} />}

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
              {server.runtime === "managed" && (
                <Badge color={MCP_RUNTIME_COLOR.managed}>managed</Badge>
              )}
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

/** What a skip means, in the words an operator can act on. */
const SKIP_REASONS: Record<SkippedTool["reason"], string> = {
  exists: "already registered — the stored entry wins",
  "missing-url": "no url in the frontmatter",
  "invalid-url": "url refused",
  "bad-name": "directory name is not a usable entry name",
};

/**
 * The outcome of a sync, skips included.
 *
 * A count alone would read as success: `exists` is the ordinary case, but
 * `invalid-url` is a server nobody can call and `missing-url` is a document
 * someone wrote that produced nothing. Those are named, with their reason.
 */
function SyncSummary({ result }: { result: ToolSyncResult }) {
  const notable = result.skipped.filter((skip) => skip.reason !== "exists");
  const alreadyThere = result.skipped.length - notable.length;
  return (
    <Alert color={notable.length > 0 ? "yellow" : "teal"} variant="light">
      <Text fz="sm">
        Registered {result.created.length} · already there {alreadyThere}
        {notable.length > 0 ? ` · skipped ${notable.length}` : ""}
      </Text>
      {notable.map((skip) => (
        <Text key={skip.name} fz="xs" mt={4}>
          {skip.name} — {SKIP_REASONS[skip.reason]}
          {skip.detail ? `: ${skip.detail}` : ""}
        </Text>
      ))}
    </Alert>
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

  /**
   * The modal is mounted for the life of the page — `opened` is a prop, not a
   * mount — so the draft that just became a server is still here when the next
   * "Register MCP server" opens, headers and all.
   */
  function reset() {
    setName("");
    setUrl("");
    setDescription("");
    setContent("");
    setRows([]);
  }

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
      reset();
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
