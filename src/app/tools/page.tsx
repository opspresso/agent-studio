"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toSlug } from "@/domain/naming";
import { createMcp, listMcps, type McpServer } from "./api";
import { HeaderRowsEditor, rowsToRecord, type HeaderRow } from "@/app/_components/HeaderRows";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { IconTool } from "@tabler/icons-react";
import { FormModal } from "@/app/_components/FormModal";
import { monoInput } from "@/app/_components/monoInput";
import { useDisclosure } from "@mantine/hooks";
import { CardGrid } from "@/app/_components/CardGrid";
import { ManagedMcpModal } from "./_components/ManagedMcpModal";
import { CredentialBadges } from "./_components/CredentialBadges";
import { MCP_RUNTIME_COLOR, PLUGIN_COLOR } from "@/app/_components/badgeColors";
import { CatalogHeader } from "@/app/_components/CatalogHeader";
import { CatalogSearch, matchesFilter } from "@/app/_components/CatalogSearch";
import { parsePluginSource } from "@/domain/plugin/types";
import { useViewer } from "@/app/_lib/useViewer";
import { useT } from "@/app/_i18n/provider";
import { reportError } from "@/app/_lib/reportError";
import { createLatestOnly } from "@/app/_lib/latestOnly";

export default function ToolsPage() {
  const t = useT();
  const viewer = useViewer();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [registerOpened, register] = useDisclosure(false);
  const [managedOpened, managed] = useDisclosure(false);
  const [filter, setFilter] = useState("");
  const latestOnly = useRef(createLatestOnly()).current;

  async function refresh() {
    const isCurrent = latestOnly();
    setLoading(true);
    setError(null);
    try {
      const loaded = await listMcps();
      if (isCurrent()) setServers(loaded);
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : "Failed to load MCP servers");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const visibleItems = servers.filter((server) =>
    matchesFilter(filter, server.name, server.description),
  );

  return (
    <Stack gap="lg">
      <CatalogHeader
        title={t("nav.tools")}
        description={t("tools.lede")}
        Icon={IconTool}
      >
        {viewer?.isAdmin && <Group gap="xs">
          <Button variant="default" onClick={managed.open}>
            {t("tools.runManaged")}
          </Button>
          <Button onClick={register.open}>{t("tools.register")}</Button>
        </Group>}
      </CatalogHeader>

      <Alert color="blue" variant="light" title={t("capabilities.descriptionTitle")}>
        {t("tools.descriptionRole")}
      </Alert>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {servers.length > 0 && (
        <CatalogSearch
          value={filter}
          onChange={setFilter}
          placeholder={t("tools.filter")}
          resultCount={visibleItems.length}
          totalCount={servers.length}
          onReset={filter ? () => setFilter("") : undefined}
        />
      )}

      <CardGrid
        loading={loading}
        empty={visibleItems.length === 0}
        emptyText={t(servers.length === 0 ? "tools.empty" : "catalog.noResults")}
      >
        {visibleItems.map((server) => {
          const plugin = server.source ? parsePluginSource(server.source) : null;
          return (
            <Card key={server.name} component={Link} href={`/tools/${server.name}`} h="100%">
              <Group gap="xs" wrap="wrap">
                <Text fw={500}>{server.name}</Text>
                {plugin && <Badge color={PLUGIN_COLOR}>{plugin.plugin}</Badge>}
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
          );
        })}
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
  const t = useT();
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

  async function submit() {
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
      setError(reportError(err, "Failed to register MCP server"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title={t("tools.registerTitle")}
      error={error}
      onSubmit={submit}
      submitLabel={t("registry.register")}
      submitting={submitting}
    >
      <TextInput
        label={t("registry.nameLabel")}
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        onBlur={() => setName(toSlug(name))}
        placeholder={t("tools.namePlaceholder")}
        required
        description={t("registry.nameHint")}
        inputWrapperOrder={["label", "input", "description", "error"]}
      />
      <TextInput
        label={t("registry.url")}
        value={url}
        onChange={(e) => setUrl(e.currentTarget.value)}
        placeholder="https://example.com/mcp"
        type="url"
        required
      />
      <TextInput
        label={t("registry.description")}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
        placeholder={t("tools.descriptionPlaceholder")}
        description={t("tools.descriptionHint")}
        inputWrapperOrder={["label", "input", "description", "error"]}
      />
      <Textarea
        label={t("registry.content")}
        value={content}
        onChange={(e) => setContent(e.currentTarget.value)}
        placeholder={t("tools.contentPlaceholder")}
        autosize
        minRows={6}
        maxRows={24}
        description={t("registry.operatorNotes")}
        inputWrapperOrder={["label", "input", "description", "error"]}
        styles={monoInput}
      />

      <HeaderRowsEditor rows={rows} onChange={setRows} />
    </FormModal>
  );
}
