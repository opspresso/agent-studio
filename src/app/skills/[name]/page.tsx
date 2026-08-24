"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { deleteSkill, getSkill, updateSkill, type Skill } from "../api";
import { BackLink } from "@/app/_components/BackLink";
import { LoadingText } from "@/app/_components/PageState";
import { useConfirm } from "@/app/_components/useConfirm";
import { createLatestOnly } from "@/app/_lib/latestOnly";
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
  Title,
} from "@mantine/core";
import { monoInput } from "@/app/_components/monoInput";
import { PLUGIN_COLOR } from "@/app/_components/badgeColors";
import { parsePluginSource } from "@/domain/plugin/types";
import { useViewer } from "@/app/_lib/useViewer";
import { useT } from "@/app/_i18n/provider";
import { reportError } from "@/app/_lib/reportError";

export default function SkillDetailPage() {
  const t = useT();
  const params = useParams<{ name: string }>();
  const name = params.name;
  const router = useRouter();
  const viewer = useViewer();

  const [skill, setSkill] = useState<Skill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  // `refresh` is called from the effect below *and* by hand after an edit, so
  // the answer that arrives is not necessarily the one still being waited for.
  const latestOnly = useRef(createLatestOnly()).current;

  async function refresh() {
    const isCurrent = latestOnly();
    setLoading(true);
    setError(null);
    try {
      const loaded = await getSkill(name);
      if (isCurrent()) setSkill(loaded);
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : "Failed to load skill");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  // `refresh` is deliberately not a dependency: it is rebuilt every render, and
  // the name is the only thing the answer depends on.
  useEffect(() => {
    void refresh();
  }, [name]);

  const { confirm, confirmModal } = useConfirm();

  async function onDelete() {
    if (
      !(await confirm({
        title: "Delete skill",
        message: `Delete skill "${name}"? This cannot be undone.`,
        confirmLabel: "Delete",
      }))
    ) {
      return;
    }
    try {
      await deleteSkill(name);
      router.push("/skills");
    } catch (e) {
      setError(reportError(e, "Failed to delete skill"));
    }
  }

  if (loading) {
    return <LoadingText />;
  }

  if (error && !skill) {
    return (
      <Stack gap="md">
        <BackLink href="/skills" label={t("nav.skills")} />
        <Alert color="red" variant="light">
          {error}
        </Alert>
      </Stack>
    );
  }

  if (!skill) {
    return null;
  }

  const plugin = skill.source ? parsePluginSource(skill.source) : null;

  return (
    <Stack gap="lg">
      {confirmModal}
      <BackLink href="/skills" label={t("nav.skills")} />

      <Group justify="space-between" align="flex-start" gap="md">
        <div>
          <Group gap="xs" wrap="nowrap">
            <Title order={1} fz="h2">
              {skill.name}
            </Title>
            {plugin && (
              <Badge
                color={PLUGIN_COLOR}
                component={Link}
                href={`/plugins/${plugin.plugin}`}
                style={{ cursor: "pointer" }}
              >
                {plugin.plugin}
              </Badge>
            )}
          </Group>
          <Text fz="sm" c="dimmed" mt={4}>
            {skill.description}
          </Text>
          {skill.source && (
            <Text fz="xs" c="dimmed" mt={4}>
              Owned by {skill.source} — the console cannot edit or delete it. Change it in the
              repository; the sync applies it.
            </Text>
          )}
        </div>
        {/* A repo-owned skill has no console actions at all: the API refuses
            them, so offering the buttons would only manufacture a 403. */}
        {!editing && viewer?.isAdmin && !skill.source && (
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
            <Text fz="sm" fw={500} c="dimmed" mb="xs">{t("registry.contentHeading")}</Text>
            <Card>
              <Text ff="monospace" fz="sm" style={{ whiteSpace: "pre-wrap" }}>
                {skill.content || <Text component="span" c="dimmed">{t("skills.noContent")}</Text>}
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
function EditSkillForm({
  skill,
  onCancel,
  onSaved,
}: {
  skill: Skill;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useT();
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
      setError(reportError(err, "Failed to save"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <Stack gap="md">
        <TextInput
          label={t("registry.description")}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          required
        />
        <Textarea
          label={t("registry.content")}
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
