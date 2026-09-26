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
  Group,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { IconArrowRight, IconBook2 } from "@tabler/icons-react";
import { FormModal } from "@/app/_components/FormModal";
import { monoInput } from "@/app/_components/monoInput";
import { useDisclosure } from "@mantine/hooks";
import { EmptyState, LoadingText } from "@/app/_components/PageState";
import { CatalogViewToggle, useCatalogView } from "@/app/_components/CatalogView";
import rows from "@/app/_components/CatalogRows.module.css";
import { PageHeader } from "@/app/_components/PageHeader";
import { CatalogSearch, matchesFilter } from "@/app/_components/CatalogSearch";
import { PLUGIN_COLOR } from "@/app/_components/badgeColors";
import { useViewer } from "@/app/_lib/useViewer";
import { useT } from "@/app/_i18n/provider";
import { reportError } from "@/app/_lib/reportError";
import { createLatestOnly } from "@/app/_lib/latestOnly";

export default function SkillsPage() {
  const t = useT();
  const [view, setView] = useCatalogView();
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

      <Text fz="sm" c="dimmed" maw={920}>
        <strong>{t("capabilities.descriptionTitle")}.</strong> {t("skills.descriptionRole")}
      </Text>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {skills.length > 0 && (
        <Group align="flex-start" justify="space-between" gap="md">
          <CatalogSearch value={filter} onChange={setFilter} placeholder={t("skills.filter")}
            resultCount={visibleItems.length} totalCount={skills.length}
            onReset={filter ? () => setFilter("") : undefined} />
          <CatalogViewToggle value={view} onChange={setView} />
        </Group>
      )}

      {loading && <LoadingText />}
      {!loading && !error && visibleItems.length === 0 && (
        <EmptyState>{t(skills.length === 0 ? "skills.empty" : "catalog.noResults")}</EmptyState>
      )}
      {!loading && visibleItems.length > 0 && (
        <div className={rows.collection}><div className={view === "grid" ? rows.grid : rows.list}>
          {visibleItems.map((skill) => {
          const plugin = skill.source ? parsePluginSource(skill.source) : null;
          return (
            <Link key={skill.name} href={`/skills/${skill.name}`} className={rows.row}>
              <div className={rows.identity}>
                <Group gap="xs" wrap="wrap"><Text className={rows.name}>{skill.name}</Text>
                  {plugin && <Badge color={PLUGIN_COLOR}>{plugin.plugin}</Badge>}</Group>
              </div>
              <Text className={rows.description} lineClamp={2}>{skill.description}</Text>
              <div className={rows.meta}><Text fz="xs">{t("skills.attachmentsCount", { count: skill.files })}</Text></div>
              <IconArrowRight className={rows.arrow} size={18} aria-hidden="true" />
            </Link>
          );
          })}
        </div></div>
      )}

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
