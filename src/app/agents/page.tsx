"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CopyableUrl } from "@/app/_components/CopyableUrl";
import { toSlug } from "@/domain/naming";
import {
  createAgent,
  listA2aProjects,
  listAgents,
  type A2aProjectListItem,
  type A2aProjectListView,
  type AgentProtocol,
  type ExternalAgent,
} from "./api";
import { HeaderRowsEditor, rowsToRecord, type HeaderRow } from "@/app/_components/HeaderRows";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconRobot } from "@tabler/icons-react";
import { CodeBlock } from "@/app/_components/CodeBlock";
import { FormModal } from "@/app/_components/FormModal";
import { LoadingText } from "@/app/_components/PageState";
import { useDisclosure } from "@mantine/hooks";
import { CardGrid, CardList } from "@/app/_components/CardGrid";
import { AGENT_PROTOCOL_COLOR, AGENT_PROTOCOL_LABEL, BADGE } from "@/app/_components/badgeColors";
import { CatalogHeader } from "@/app/_components/CatalogHeader";
import { CatalogSearch, matchesFilter } from "@/app/_components/CatalogSearch";
import { useViewer } from "@/app/_lib/useViewer";
import { useT } from "@/app/_i18n/provider";

export default function AgentsPage() {
  const t = useT();
  const viewer = useViewer();
  const [agents, setAgents] = useState<ExternalAgent[]>([]);
  const [a2aProjects, setA2aProjects] = useState<A2aProjectListView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opened, { open, close }] = useDisclosure(false);
  const [filter, setFilter] = useState("");
  const [cardProject, setCardProject] = useState<A2aProjectListItem | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [agentList, projectList] = await Promise.all([listAgents(), listA2aProjects()]);
      setAgents(agentList);
      setA2aProjects(projectList);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load agents");
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
        title={t("nav.agents")}
        description={t("agents.lede")}
        Icon={IconRobot}
      >
        {viewer?.isAdmin && <Button onClick={open}>{t("agents.register")}</Button>}
      </CatalogHeader>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {agents.length > 0 && (
        <CatalogSearch value={filter} onChange={setFilter} placeholder={t("agents.filter")} />
      )}

      <CardGrid
        loading={loading}
        empty={agents.length === 0}
        emptyText={t("agents.empty")}
      >
        {agents
          .filter((agent) => matchesFilter(filter, agent.name, agent.description))
          .map((agent) => {
            const headerCount = Object.keys(agent.headers).length;
            return (
              <Card key={agent.name} component={Link} href={`/agents/${agent.name}`} h="100%">
                <Group gap="xs">
                  <Text fw={500}>{agent.name}</Text>
                  <Badge color={AGENT_PROTOCOL_COLOR[agent.protocol ?? "openai"]}>
                    {AGENT_PROTOCOL_LABEL[agent.protocol ?? "openai"]}
                  </Badge>
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

      {!loading && a2aProjects && a2aProjects.projects.length > 0 && (
        <Stack component="section" gap="sm">
          <div>
            <Title order={2} fz="h4">
              Workspace projects (A2A)
            </Title>
            <Text fz="sm" c="dimmed" mt={4}>
              {a2aProjects.enabled
                ? "Published projects, exposed as A2A agents — share the Agent Card URL, no registration needed."
                : "Published projects. Generate an A2A key in Settings to expose them as A2A agents."}
            </Text>
          </div>
          <CardList>
            {a2aProjects.projects.map((project) => (
              <Card
                key={project.name}
                component="button"
                type="button"
                onClick={() => setCardProject(project)}
                h="100%"
              >
                <Group gap="xs">
                  <Text fw={500}>{project.displayName || project.name}</Text>
                  <Badge color={AGENT_PROTOCOL_COLOR.a2a}>{AGENT_PROTOCOL_LABEL.a2a}</Badge>
                </Group>
                <Text fz="sm" c="dimmed" mt={4} lineClamp={2}>
                  {project.description}
                </Text>
                {a2aProjects.enabled && (
                  <Text fz="xs" c="dimmed" mt="xs" truncate>
                    {project.cardUrl}
                  </Text>
                )}
              </Card>
            ))}
          </CardList>
        </Stack>
      )}

      <RegisterAgentModal
        opened={opened}
        onClose={close}
        onCreated={() => {
          close();
          void refresh();
        }}
      />

      <AgentCardModal project={cardProject} onClose={() => setCardProject(null)} />
    </Stack>
  );
}

function AgentCardModal({
  project,
  onClose,
}: {
  project: A2aProjectListItem | null;
  onClose: () => void;
}) {
  const [card, setCard] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!project) {
      return;
    }
    let cancelled = false;
    setCard(null);
    setError(null);
    fetch(project.cardUrl)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`);
        }
        return res.json();
      })
      .then((data) => !cancelled && setCard(JSON.stringify(data, null, 2)))
      .catch(
        (e) =>
          !cancelled && setError(e instanceof Error ? e.message : "Failed to load the Agent Card"),
      );
    return () => {
      cancelled = true;
    };
  }, [project]);

  return (
    <Modal
      opened={project !== null}
      onClose={onClose}
      title={project ? `Agent Card — ${project.displayName || project.name}` : ""}
      size="lg"
    >
      {project && (
        <Stack gap="sm">
          <CopyableUrl url={project.cardUrl} />
          {error ? (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          ) : card ? (
            <CodeBlock language="json" code={card} />
          ) : (
            <LoadingText />
          )}
          <Anchor component={Link} href={`/projects/${project.name}`} fz="sm">
            Open project →
          </Anchor>
        </Stack>
      )}
    </Modal>
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
  const [protocol, setProtocol] = useState<AgentProtocol>("openai");
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
    setProtocol("openai");
    setDescription("");
    setRows([]);
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await createAgent({ name, url, protocol, description, headers: rowsToRecord(rows) });
      reset();
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to register agent");
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
      <Select
        label={t("agents.protocol")}
        value={protocol}
        onChange={(value) => setProtocol((value ?? "openai") as AgentProtocol)}
        allowDeselect={false}
        data={[
          { value: "openai", label: "OpenAI-compatible" },
          { value: "a2a", label: "A2A" },
        ]}
      />
      <TextInput
        label={protocol === "a2a" ? t("agents.cardUrl") : t("registry.url")}
        value={url}
        onChange={(e) => setUrl(e.currentTarget.value)}
        placeholder={
          protocol === "a2a"
            ? "https://example.com/.well-known/agent-card.json"
            : "https://example.com/v1/chat/completions"
        }
        type="url"
        required
      />
      <TextInput
        label={t("registry.description")}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
        required
      />

      <HeaderRowsEditor
        rows={rows}
        onChange={setRows}
        emptyHint={t("registry.headersEmpty")}
      />
    </FormModal>
  );
}
