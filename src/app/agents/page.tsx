"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CopyableUrl } from "@/app/_components/CopyableUrl";
import { toSlug } from "@/shared/slug";
import {
  createAgent,
  listA2aProjects,
  listAgents,
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
import { useDisclosure } from "@mantine/hooks";
import { CardGrid, CardList } from "@/app/_components/CardGrid";
import { AGENT_PROTOCOL_COLOR, AGENT_PROTOCOL_LABEL } from "@/app/_components/badgeColors";
import { CatalogHeader } from "@/app/_components/CatalogHeader";

export default function AgentsPage() {
  const [agents, setAgents] = useState<ExternalAgent[]>([]);
  const [a2aProjects, setA2aProjects] = useState<A2aProjectListView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opened, { open, close }] = useDisclosure(false);

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
        title="Agents"
        description="External OpenAI-compatible and A2A endpoints, ready to join agent workflows."
        Icon={IconRobot}
      >
        <Button onClick={open}>Register agent</Button>
      </CatalogHeader>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      <CardGrid loading={loading} empty={agents.length === 0} emptyText="No external agents yet.">
        {agents.map((agent) => (
          <Card key={agent.name} component={Link} href={`/agents/${agent.name}`} h="100%">
            <Group gap="xs">
              <Text fw={500}>{agent.name}</Text>
              <Badge color={AGENT_PROTOCOL_COLOR[agent.protocol ?? "openai"]}>
                {AGENT_PROTOCOL_LABEL[agent.protocol ?? "openai"]}
              </Badge>
            </Group>
            <Text fz="sm" c="dimmed" mt={4} lineClamp={2}>
              {agent.description}
            </Text>
            <Text fz="xs" c="dimmed" mt="xs" truncate>
              {agent.url}
            </Text>
          </Card>
        ))}
      </CardGrid>

      {!loading && a2aProjects && a2aProjects.projects.length > 0 && (
        <Stack component="section" gap="sm">
          <div>
            <Title order={2} fz="h4">
              Studio projects (A2A)
            </Title>
            <Text fz="sm" c="dimmed" mt={4}>
              {a2aProjects.enabled
                ? "Published projects, exposed as A2A agents — share the Agent Card URL, no registration needed."
                : "Published projects. Set A2A_API_KEY on the server to expose them as A2A agents."}
            </Text>
          </div>
          <CardList>
            {a2aProjects.projects.map((project) => (
              <Card key={project.name} h="100%">
                <Group gap="xs">
                  <Anchor component={Link} href={`/projects/${project.name}`} fw={500} c="inherit">
                    {project.displayName || project.name}
                  </Anchor>
                  <Badge color={AGENT_PROTOCOL_COLOR.a2a}>{AGENT_PROTOCOL_LABEL.a2a}</Badge>
                </Group>
                <Text fz="sm" c="dimmed" mt={4} lineClamp={2}>
                  {project.description}
                </Text>
                {a2aProjects.enabled && (
                  <div style={{ marginTop: "var(--mantine-spacing-xs)" }}>
                    <CopyableUrl url={project.cardUrl} />
                  </div>
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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
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
    <Modal opened={opened} onClose={onClose} title="Register external agent" size="lg">
      <form onSubmit={submit}>
        <Stack gap="md">
          <TextInput
            label="Name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            onBlur={() => setName(toSlug(name))}
            placeholder="my-agent"
            required
            description="Lowercase letters, digits, and hyphens only."
            inputWrapperOrder={["label", "input", "description", "error"]}
          />
          <Select
            label="Protocol"
            value={protocol}
            onChange={(value) => setProtocol((value ?? "openai") as AgentProtocol)}
            allowDeselect={false}
            data={[
              { value: "openai", label: "OpenAI-compatible" },
              { value: "a2a", label: "A2A" },
            ]}
          />
          <TextInput
            label={protocol === "a2a" ? "Agent Card URL" : "URL"}
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
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            required
          />

          <HeaderRowsEditor
            rows={rows}
            onChange={setRows}
            emptyHint="No headers. Add one if the endpoint needs auth."
          />

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
