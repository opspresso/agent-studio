"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toSlug } from "@/shared/slug";
import { SyncSummary } from "@/app/_components/SyncSummary";
import {
  createMcp,
  getToolsSyncConfig,
  listMcps,
  syncTools,
  type McpServer,
  type RepoSyncResult,
  type RepoSyncConfig,
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
} from "@mantine/core";
import { IconTool } from "@tabler/icons-react";
import { monoInput } from "@/app/_components/monoInput";
import { useDisclosure } from "@mantine/hooks";
import { CardGrid } from "@/app/_components/CardGrid";
import { ManagedMcpModal } from "./_components/ManagedMcpModal";
import { CredentialBadges } from "./_components/CredentialBadges";
import { MCP_RUNTIME_COLOR } from "@/app/_components/badgeColors";
import { CatalogHeader } from "@/app/_components/CatalogHeader";
import { useViewer } from "@/app/_lib/useViewer";

export default function ToolsPage() {
  const viewer = useViewer();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [registerOpened, register] = useDisclosure(false);
  const [managedOpened, managed] = useDisclosure(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<RepoSyncResult | null>(null);
  const [syncConfig, setSyncConfig] = useState<RepoSyncConfig | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [nextServers, config] = await Promise.all([listMcps(), getToolsSyncConfig()]);
      setServers(nextServers);
      setSyncConfig(config);
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
      <CatalogHeader
        title="Tools"
        description="MCP servers that expose tools to agents over streamable HTTP."
        Icon={IconTool}
      >
        {viewer?.isAdmin && <Group gap="xs">
          <Button
            variant="default"
            loading={syncing}
            disabled={!syncConfig?.configured}
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
        </Group>}
      </CatalogHeader>

      {syncConfig && (
        <Text fz="xs" c={syncConfig.configured ? "dimmed" : "orange"}>
          {syncConfig.configured
            ? `GitHub source: ${syncConfig.repo} · ${syncConfig.branch}`
            : "GitHub sync is not configured. Add the repository and token in Settings."}
        </Text>
      )}

      {syncResult && (
        <SyncSummary
          result={syncResult}
          label="tool"
          onApply={async (selection) => {
            setSyncResult(await syncTools(selection));
            await refresh();
          }}
        />
      )}

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
