"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { deleteSkill, getSkill, updateSkill, type Skill } from "../api";
import {
  Alert,
  Anchor,
  Button,
  Card,
  Group,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { monoInput } from "@/app/_components/monoInput";
import { useViewer } from "@/app/_lib/useViewer";

export default function SkillDetailPage() {
  const params = useParams<{ name: string }>();
  const name = params.name;
  const router = useRouter();
  const viewer = useViewer();

  const [skill, setSkill] = useState<Skill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setSkill(await getSkill(name));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load skill");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  async function onDelete() {
    if (!confirm(`Delete skill "${name}"? This cannot be undone.`)) {
      return;
    }
    try {
      await deleteSkill(name);
      router.push("/skills");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete skill");
    }
  }

  if (loading) {
    return (
      <Text fz="sm" c="dimmed">
        Loading…
      </Text>
    );
  }

  if (error && !skill) {
    return (
      <Stack gap="md">
        <BackLink />
        <Alert color="red" variant="light">
          {error}
        </Alert>
      </Stack>
    );
  }

  if (!skill) {
    return null;
  }

  return (
    <Stack gap="lg">
      <BackLink />

      <Group justify="space-between" align="flex-start" gap="md">
        <div>
          <Title order={1} fz="h2">
            {skill.name}
          </Title>
          <Text fz="sm" c="dimmed" mt={4}>
            {skill.description}
          </Text>
          {skill.source && (
            <Text fz="xs" c="orange" mt={4}>
              Synced from {skill.source} — a local edit stays until an operator applies the
              repository&apos;s version on a plugins sync.
            </Text>
          )}
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
        <EditSkillForm
          skill={skill}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void refresh();
          }}
        />
      ) : (
        <>
          <section>
            <Text fz="sm" fw={500} c="dimmed" mb="xs">Content</Text>
            <Card>
              <Text ff="monospace" fz="sm" style={{ whiteSpace: "pre-wrap" }}>
                {skill.content || <Text component="span" c="dimmed">No content.</Text>}
              </Text>
            </Card>
          </section>
          <section>
            <Text fz="sm" fw={500} c="dimmed" mb="xs">
              Attachment files ({skill.files?.length ?? 0})
            </Text>
            {!skill.files?.length ? (
              <Text fz="sm" c="dimmed">None.</Text>
            ) : (
              <Stack gap="xs">
                {skill.files.map((file) => (
                  <Card key={file.path}>
                    <Text ff="monospace" fz="sm" fw={500} mb="xs">{file.path}</Text>
                    <Text ff="monospace" fz="xs" style={{ whiteSpace: "pre-wrap" }}>{file.content}</Text>
                  </Card>
                ))}
              </Stack>
            )}
          </section>
        </>
      )}
    </Stack>
  );
}

function BackLink() {
  return (
    <Anchor component={Link} href="/skills" fz="sm" c="dimmed">
      ← Back to skills
    </Anchor>
  );
}

function EditSkillForm({
  skill,
  onCancel,
  onSaved,
}: {
  skill: Skill;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [description, setDescription] = useState(skill.description);
  const [content, setContent] = useState(skill.content);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await updateSkill(skill.name, { description, content });
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
        <TextInput
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          required
        />
        <Textarea
          label="Content (markdown)"
          value={content}
          onChange={(e) => setContent(e.currentTarget.value)}
          autosize
          minRows={16}
          maxRows={40}
          styles={monoInput}
        />

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
