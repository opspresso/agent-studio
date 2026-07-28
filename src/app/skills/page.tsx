"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toSlug } from "@/shared/slug";
import { createSkill, listSkills, type Skill } from "./api";
import {
  Alert,
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

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opened, { open, close }] = useDisclosure(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setSkills(await listSkills());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load skills");
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
            Skills
          </Title>
          <Text fz="sm" c="dimmed" mt={4}>
            Markdown behavior instructions loaded on demand by the agent engine.
          </Text>
        </div>
        <Group gap="sm">
          {syncStatus && (
            <Text fz="xs" c="dimmed">
              {syncStatus}
            </Text>
          )}
          <Button
            variant="default"
            loading={syncing}
            onClick={async () => {
              setSyncing(true);
              setSyncStatus(null);
              setError(null);
              try {
                const res = await fetch("/api/skills/sync", { method: "POST" });
                const data = (await res.json()) as {
                  synced?: string[];
                  unchanged?: number;
                  error?: string;
                };
                if (!res.ok) {
                  setError(data.error ?? "Sync failed");
                } else {
                  setSyncStatus(
                    `Synced ${data.synced?.length ?? 0} · unchanged ${data.unchanged ?? 0}`,
                  );
                  await refresh();
                }
              } catch (e) {
                setError(e instanceof Error ? e.message : "Sync failed");
              } finally {
                setSyncing(false);
              }
            }}
          >
            Sync from GitHub
          </Button>
          <Button onClick={open}>New skill</Button>
        </Group>
      </Group>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      <CardGrid
        loading={loading}
        empty={skills.length === 0}
        emptyText="No skills yet. Create your first one."
      >
        {skills.map((skill) => (
          <Card key={skill.name} component={Link} href={`/skills/${skill.name}`} h="100%">
            <Text fw={500}>{skill.name}</Text>
            <Text fz="sm" c="dimmed" mt={4} lineClamp={3}>
              {skill.description}
            </Text>
          </Card>
        ))}
      </CardGrid>

      <CreateSkillModal
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

function CreateSkillModal({
  opened,
  onClose,
  onCreated,
}: {
  opened: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createSkill({ name, description, content });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create skill");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="New skill" size="lg">
      <form onSubmit={submit}>
        <Stack gap="md">
          <TextInput
            label="Name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            onBlur={() => setName(toSlug(name))}
            placeholder="my-skill"
            required
            description="Lowercase letters, digits, and hyphens only."
            inputWrapperOrder={["label", "input", "description", "error"]}
          />
          <TextInput
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            placeholder="One-line summary shown to the model"
            required
          />
          <Textarea
            label="Content (markdown)"
            value={content}
            onChange={(e) => setContent(e.currentTarget.value)}
            placeholder="# Instructions…"
            autosize
            minRows={8}
            maxRows={30}
            styles={monoInput}
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
              Create
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
