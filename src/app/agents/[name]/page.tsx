"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  deleteAgent,
  getAgent,
  sendAgentMessage,
  updateAgent,
  type AgentProtocol,
  type ExternalAgent,
} from "../api";
import { BackLink } from "@/app/_components/BackLink";
import { HeaderRowsEditor, recordToRows, rowsToRecord, type HeaderRow } from "@/app/_components/HeaderRows";
import { LoadingText } from "@/app/_components/PageState";
import { useConfirm } from "@/app/_components/useConfirm";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { AGENT_PROTOCOL_COLOR, AGENT_PROTOCOL_LABEL } from "@/app/_components/badgeColors";
import { useViewer } from "@/app/_lib/useViewer";

export default function AgentDetailPage() {
  const params = useParams<{ name: string }>();
  const name = params.name;
  const router = useRouter();
  const viewer = useViewer();

  const [agent, setAgent] = useState<ExternalAgent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setAgent(await getAgent(name));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load agent");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  const { confirm, confirmModal } = useConfirm();

  async function onDelete() {
    if (
      !(await confirm({
        title: "Delete agent",
        message: `Delete agent "${name}"? This cannot be undone.`,
        confirmLabel: "Delete",
      }))
    ) {
      return;
    }
    try {
      await deleteAgent(name);
      router.push("/agents");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete agent");
    }
  }

  if (loading) {
    return <LoadingText />;
  }

  if (error && !agent) {
    return (
      <Stack gap="md">
        <BackLink href="/agents" label="agents" />
        <Alert color="red" variant="light">
          {error}
        </Alert>
      </Stack>
    );
  }

  if (!agent) {
    return null;
  }

  const headerEntries = Object.entries(agent.headers);

  return (
    <Stack gap="lg">
      {confirmModal}
      <BackLink href="/agents" label="agents" />

      <Group justify="space-between" align="flex-start" gap="md">
        <div>
          <Group gap="xs">
            <Title order={1} fz="h2">
              {agent.name}
            </Title>
            <Badge color={AGENT_PROTOCOL_COLOR[agent.protocol ?? "openai"]}>
              {AGENT_PROTOCOL_LABEL[agent.protocol ?? "openai"]}
            </Badge>
          </Group>
          <Text fz="sm" c="dimmed" mt={4}>
            {agent.description}
          </Text>
          <Text fz="xs" c="dimmed" mt={4}>
            {agent.url}
          </Text>
        </div>
        {!editing && viewer?.isAdmin && (
          <Group gap="xs" wrap="nowrap">
            <Button variant="default" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button variant="default" color="red" onClick={onDelete}>
              Delete
            </Button>
          </Group>
        )}
      </Group>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {editing ? (
        <EditAgentForm
          agent={agent}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void refresh();
          }}
        />
      ) : (
        <>
          <section>
            <Text fz="sm" fw={500} c="dimmed" mb="xs">
              Headers
            </Text>
            {headerEntries.length === 0 ? (
              <Text fz="sm" c="dimmed">
                None.
              </Text>
            ) : (
              <Card padding={0}>
                {headerEntries.map(([key, value], index) => (
                  <Group
                    key={key}
                    justify="space-between"
                    px="md"
                    py="xs"
                    wrap="nowrap"
                    style={
                      index > 0
                        ? { borderTop: "1px solid var(--mantine-color-default-border)" }
                        : undefined
                    }
                  >
                    <Text ff="monospace" fz="sm">
                      {key}
                    </Text>
                    <Text ff="monospace" fz="sm" c="dimmed" truncate>
                      {value}
                    </Text>
                  </Group>
                ))}
              </Card>
            )}
          </section>

          <MessageTester name={agent.name} />
        </>
      )}
    </Stack>
  );
}
function MessageTester({ name }: { name: string }) {
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    setReply(null);
    try {
      setReply(await sendAgentMessage(name, message));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <section>
      <Text fz="sm" fw={500} c="dimmed" mb="xs">
        Test message
      </Text>
      <form onSubmit={submit}>
        <Stack gap="sm" align="flex-start">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.currentTarget.value)}
            autosize
            minRows={3}
            maxRows={12}
            required
            placeholder="Send one message to the agent…"
            w="100%"
          />
          <Button type="submit" variant="default" loading={sending}>
            Send
          </Button>
        </Stack>
      </form>

      {error && (
        <Alert color="red" variant="light" mt="sm">
          {error}
        </Alert>
      )}

      {reply !== null && (
        <div style={{ marginTop: "var(--mantine-spacing-sm)" }}>
          <Text fz="xs" fw={500} c="dimmed" mb={4}>
            Assistant reply
          </Text>
          <Card>
            <Text fz="sm" style={{ whiteSpace: "pre-wrap" }}>
              {reply || (
                <Text component="span" c="dimmed">
                  Empty response.
                </Text>
              )}
            </Text>
          </Card>
        </div>
      )}
    </section>
  );
}

function EditAgentForm({
  agent,
  onCancel,
  onSaved,
}: {
  agent: ExternalAgent;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [url, setUrl] = useState(agent.url);
  const [protocol, setProtocol] = useState<AgentProtocol>(agent.protocol ?? "openai");
  const [description, setDescription] = useState(agent.description);
  const [rows, setRows] = useState<HeaderRow[]>(recordToRows(agent.headers));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await updateAgent(agent.name, { url, protocol, description, headers: rowsToRecord(rows) });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <Stack gap="md">
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
        <Text fz="xs" c="dimmed">
          Masked values keep the stored secret. Type a new value to replace it.
        </Text>

        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}

        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" loading={submitting}>
            Save
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
