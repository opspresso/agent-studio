"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toSlug } from "@/shared/slug";
import { parsePluginSource } from "@/domain/plugin/types";
import { createSkill, listSkills, type SkillSummary } from "./api";
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
import { IconBook2 } from "@tabler/icons-react";
import { FormModal } from "@/app/_components/FormModal";
import { monoInput } from "@/app/_components/monoInput";
import { useDisclosure } from "@mantine/hooks";
import { CardGrid } from "@/app/_components/CardGrid";
import { CatalogHeader } from "@/app/_components/CatalogHeader";
import { CatalogSearch, matchesFilter } from "@/app/_components/CatalogSearch";
import { PLUGIN_COLOR } from "@/app/_components/badgeColors";
import { useViewer } from "@/app/_lib/useViewer";

export default function SkillsPage() {
  const viewer = useViewer();
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opened, { open, close }] = useDisclosure(false);
  const [filter, setFilter] = useState("");

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
      <CatalogHeader
        title="Skills"
        description="Markdown behavior instructions loaded on demand by the agent engine. Synced skills arrive through Plugins."
        Icon={IconBook2}
      >
        {viewer?.isAdmin && <Button onClick={open}>New skill</Button>}
      </CatalogHeader>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {skills.length > 0 && (
        <CatalogSearch value={filter} onChange={setFilter} placeholder="Filter skills…" />
      )}

      <CardGrid
        loading={loading}
        empty={skills.length === 0}
        emptyText="No skills yet. Sync a plugins repo, or create one here."
      >
        {skills
          .filter((skill) => matchesFilter(filter, skill.name, skill.description))
          .map((skill) => {
            const plugin = skill.source ? parsePluginSource(skill.source) : null;
            const files = skill.files;
            return (
              <Card key={skill.name} component={Link} href={`/skills/${skill.name}`} h="100%">
                <Group gap="xs" wrap="nowrap">
                  <Text fw={500} truncate>
                    {skill.name}
                  </Text>
                  {plugin && <Badge color={PLUGIN_COLOR}>{plugin.plugin}</Badge>}
                </Group>
                <Text fz="sm" c="dimmed" mt={4} lineClamp={2}>
                  {skill.description}
                </Text>
                {files > 0 && (
                  <Text fz="xs" c="dimmed" mt={6}>
                    {files} attachment{files === 1 ? "" : "s"}
                  </Text>
                )}
              </Card>
            );
          })}
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

  /**
   * The modal is mounted for the life of the page — `opened` is a prop, not a
   * mount — so the draft that just became a skill is still here when the next
   * "New skill" opens, with a whole markdown body to clear by hand.
   */
  function reset() {
    setName("");
    setDescription("");
    setContent("");
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await createSkill({ name, description, content });
      reset();
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create skill");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="New skill"
      error={error}
      onSubmit={submit}
      submitLabel="Create"
      submitting={submitting}
    >
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
    </FormModal>
  );
}
