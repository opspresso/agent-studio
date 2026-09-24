"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toSlug } from "@/domain/naming";
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
import { PageHeader } from "@/app/_components/PageHeader";
import { CatalogSearch, matchesFilter } from "@/app/_components/CatalogSearch";
import { PLUGIN_COLOR } from "@/app/_components/badgeColors";
import { useViewer } from "@/app/_lib/useViewer";
import { useT } from "@/app/_i18n/provider";
import { reportError } from "@/app/_lib/reportError";
import { createLatestOnly } from "@/app/_lib/latestOnly";

export default function SkillsPage() {
  const t = useT();
  const viewer = useViewer();
  const [skills, setSkills] = useState<SkillSummary[]>([]);
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
      const loaded = await listSkills();
      if (isCurrent()) setSkills(loaded);
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : "Failed to load skills");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const visibleItems = skills.filter((skill) =>
    matchesFilter(filter, skill.name, skill.description),
  );

  return (
    <Stack gap="lg">
      <PageHeader
        title={t("nav.skills")}
        description={t("skills.lede")}
        Icon={IconBook2}
      >
        {viewer?.isAdmin && <Button onClick={open}>{t("skills.new")}</Button>}
      </PageHeader>

      <Alert color="blue" variant="light" title={t("capabilities.descriptionTitle")}>
        {t("skills.descriptionRole")}
      </Alert>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {skills.length > 0 && (
        <CatalogSearch
          value={filter}
          onChange={setFilter}
          placeholder={t("skills.filter")}
          resultCount={visibleItems.length}
          totalCount={skills.length}
          onReset={filter ? () => setFilter("") : undefined}
        />
      )}

      <CardGrid
        loading={loading}
        failed={!!error && skills.length === 0}
        empty={visibleItems.length === 0}
        emptyText={t(skills.length === 0 ? "skills.empty" : "catalog.noResults")}
      >
        {visibleItems.map((skill) => {
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
  const t = useT();
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
      setError(reportError(err, "Failed to create skill"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title={t("skills.new")}
      error={error}
      onSubmit={submit}
      submitLabel={t("registry.create")}
      submitting={submitting}
    >
      <TextInput
        label={t("registry.nameLabel")}
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        onBlur={() => setName(toSlug(name))}
        placeholder={t("skills.namePlaceholder")}
        required
        description={t("registry.nameHint")}
        inputWrapperOrder={["label", "input", "description", "error"]}
      />
      <TextInput
        label={t("registry.description")}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
        placeholder={t("skills.descriptionPlaceholder")}
        required
        description={t("skills.descriptionHint")}
        inputWrapperOrder={["label", "input", "description", "error"]}
      />
      <Textarea
        label={t("registry.content")}
        value={content}
        onChange={(e) => setContent(e.currentTarget.value)}
        placeholder={t("skills.contentPlaceholder")}
        autosize
        minRows={8}
        maxRows={30}
        description={t("skills.contentHint")}
        inputWrapperOrder={["label", "input", "description", "error"]}
        styles={monoInput}
      />
    </FormModal>
  );
}
