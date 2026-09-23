"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toSlug } from "@/domain/naming";
import {
  createAgent,
  listAgents,
  type ExternalAgent,
} from "./api";
import { HeaderRowsEditor, rowsToRecord, type HeaderRow } from "@/app/_components/HeaderRows";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconRobot } from "@tabler/icons-react";
import { FormModal } from "@/app/_components/FormModal";
import { useDisclosure } from "@mantine/hooks";
import { CardGrid } from "@/app/_components/CardGrid";
import { BADGE } from "@/app/_components/badgeColors";
import { PageHeader } from "@/app/_components/PageHeader";
import { CatalogSearch, matchesFilter } from "@/app/_components/CatalogSearch";
import { useViewer } from "@/app/_lib/useViewer";
import { useT } from "@/app/_i18n/provider";
import { reportError } from "@/app/_lib/reportError";
import { createLatestOnly } from "@/app/_lib/latestOnly";

export default function AgentsPage() {
  const t = useT();
  const viewer = useViewer();
  const [agents, setAgents] = useState<ExternalAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opened, { open, close }] = useDisclosure(false);
  const [filter, setFilter] = useState("");
  const latestOnly = useRef(createLatestOnly()).current;

  async function refresh() {
    const isCurrent = latestOnly();
    setLoading(true);
    setError(null);
    try {
      const agentList = await listAgents();
      if (isCurrent()) {
        setAgents(agentList);
      }
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : "Failed to load agents");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const visibleItems = agents.filter((agent) =>
    matchesFilter(filter, agent.name, agent.description),
  );

  return (
    <Stack gap="lg">
      <PageHeader
        title={t("nav.agents")}
        description={t("agents.lede")}
        Icon={IconRobot}
      >
        {viewer?.isAdmin && <Button onClick={open}>{t("agents.register")}</Button>}
      </PageHeader>

      <Alert color="blue" variant="light" title={t("capabilities.descriptionTitle")}>
        {t("agents.descriptionRole")}
      </Alert>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {agents.length > 0 && (
        <CatalogSearch
          value={filter}
          onChange={setFilter}
          placeholder={t("agents.filter")}
          resultCount={visibleItems.length}
          totalCount={agents.length}
          onReset={filter ? () => setFilter("") : undefined}
        />
      )}

      <CardGrid
        loading={loading}
        empty={visibleItems.length === 0}
        emptyText={t(agents.length === 0 ? "agents.empty" : "catalog.noResults")}
      >
        {visibleItems.map((agent) => {
          const headerCount = Object.keys(agent.headers).length;
          return (
            <Card key={agent.name} component={Link} href={`/agents/${agent.name}`} h="100%">
              <Group gap="xs">
                <Text fw={500}>{agent.name}</Text>
                {headerCount > 0 && (
                  <Badge color={BADGE.on}>
                    {headerCount} header{headerCount === 1 ? "" : "s"}
                  </Badge>
                )}
              </Group>
              <Text fz="sm" c="dimmed" mt={4} lineClamp={2}>
                {agent.description}
              </Text>
              <Text fz="xs" c="dimmed" mt="xs" truncate>
                {agent.url}
              </Text>
            </Card>
          );
        })}
      </CardGrid>

      <RegisterAgentModal
        opened={opened}
        onClose={close}
        onCreated={() => {
          close();
          void refresh();
        }}
      />

    </Stack>
  );
}

function RegisterAgentModal({
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
  const [rows, setRows] = useState<HeaderRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The modal is mounted for the life of the page — `opened` is a prop, not a
   * mount — so the draft that just became an agent is still here when the next
   * "Register agent" opens, headers and all.
   */
  function reset() {
    setName("");
    setUrl("");
    setDescription("");
    setRows([]);
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await createAgent({ name, url, description, headers: rowsToRecord(rows) });
      reset();
      onCreated();
    } catch (err) {
      setError(reportError(err, "Failed to register agent"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title={t("agents.registerTitle")}
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
        placeholder={t("agents.namePlaceholder")}
        required
        description={t("registry.nameHint")}
        inputWrapperOrder={["label", "input", "description", "error"]}
      />
      <TextInput
        label={t("registry.url")}
        value={url}
        onChange={(e) => setUrl(e.currentTarget.value)}
        placeholder="https://example.com/v1/chat/completions"
        type="url"
        required
      />
      <TextInput
        label={t("registry.description")}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
        required
        placeholder={t("agents.descriptionPlaceholder")}
        description={t("agents.descriptionHint")}
        inputWrapperOrder={["label", "input", "description", "error"]}
      />

      <HeaderRowsEditor
        rows={rows}
        onChange={setRows}
        emptyHint={t("registry.headersEmpty")}
      />
    </FormModal>
  );
}
