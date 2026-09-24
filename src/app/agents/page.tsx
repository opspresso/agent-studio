"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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
import { IconRobot } from "@tabler/icons-react";
import { FormModal } from "@/app/_components/FormModal";
import { useDisclosure } from "@mantine/hooks";
import { tierMayCreateProjects } from "@/domain/member/tiers";
import { useViewer } from "@/app/_lib/useViewer";
import { toSlug } from "@/domain/naming";
import { useT } from "@/app/_i18n/provider";
import { OwnerLine } from "@/app/_components/OwnerLine";
import { createProject, listProjects, type SanitizedProject } from "./lib/api";
import { CardGrid } from "@/app/_components/CardGrid";
import { CatalogSearch, matchesFilter } from "@/app/_components/CatalogSearch";
import { PageHeader } from "@/app/_components/PageHeader";
import { reportError } from "@/app/_lib/reportError";
import { createLatestOnly } from "@/app/_lib/latestOnly";

export default function AgentsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useT();
  const viewer = useViewer();
  const mayCreate = viewer !== null && tierMayCreateProjects(viewer.tier);
  const createRequested = searchParams.get("create") === "1";
  const [projects, setProjects] = useState<SanitizedProject[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opened, { open, close }] = useDisclosure(false);
  const latestOnly = useRef(createLatestOnly()).current;

  async function refresh() {
    const isCurrent = latestOnly();
    setLoading(true);
    setError(null);
    try {
      const loaded = await listProjects();
      if (isCurrent()) setProjects(loaded);
    } catch (e) {
      if (isCurrent()) setError(e instanceof Error ? e.message : t("agents.loadFailed"));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (createRequested && mayCreate) {
      open();
      router.replace("/agents", { scroll: false });
    }
  }, [createRequested, mayCreate, open, router]);

  const visibleProjects = projects.filter((project) =>
    matchesFilter(filter, project.displayName, project.name, project.description),
  );

  return (
    <Stack gap="lg">
      <PageHeader
        title={t("nav.agents")}
        description={t("agents.lede")}
        Icon={IconRobot}
      >
        {mayCreate && (
          <Button onClick={open}>{t("agents.new")}</Button>
        )}
      </PageHeader>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {projects.length > 0 && (
        <Group align="flex-start" gap="md">
          <CatalogSearch
            value={filter}
            onChange={setFilter}
            placeholder={t("agents.filter")}
            resultCount={visibleProjects.length}
            totalCount={projects.length}
            onReset={filter ? () => setFilter("") : undefined}
          />
        </Group>
      )}

      <CardGrid
        loading={loading}
        failed={!!error && projects.length === 0}
        empty={visibleProjects.length === 0}
        emptyText={t(projects.length === 0 ? "agents.empty" : "catalog.noResults")}
      >
        {visibleProjects.map((project) => (
          <Card
            key={project.name}
            component={Link}
            href={`/agents/${project.name}`}
            h="100%"
          >
            <Group justify="space-between" gap="xs" wrap="nowrap">
              <Text fw={500} truncate>
                {project.displayName || project.name}
              </Text>
              <Group gap={6} wrap="nowrap">
                {project.visibility === "private" && (
                  <Badge variant="light" color="gray">
                    {t("agents.privateBadge")}
                  </Badge>
                )}
              </Group>
            </Group>
            <Text ff="monospace" fz="xs" c="dimmed" mt={2}>
              {project.name}
            </Text>
            <OwnerLine
              ownerEmail={project.ownerEmail}
              isMine={viewer?.email === project.ownerEmail}
              mt={4}
            />
            <Text fz="sm" c="dimmed" mt="xs" lineClamp={3}>
              {project.description}
            </Text>
          </Card>
        ))}
      </CardGrid>

      <CreateAgentModal
        opened={opened}
        onClose={close}
        onCreated={(createdName) => {
          close();
          // Initial Agent settings are available when a model fits; open the Playground.
          router.push(`/agents/${createdName}`);
        }}
      />
    </Stack>
  );
}

function CreateAgentModal({
  opened,
  onClose,
  onCreated,
}: {
  opened: boolean;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [departmentCode, setDepartmentCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  /**
   * The modal is mounted for the life of the page — `opened` is a prop, not a
   * mount — so reset the draft after creating an Agent.
   */
  function reset() {
    setName("");
    setDisplayName("");
    setDescription("");
    setDepartmentCode("");
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const project = await createProject({
        name,
        displayName: displayName || name,
        description,
        departmentCode: departmentCode || undefined,
      });
      reset();
      onCreated(project.name);
    } catch (err) {
      setError(reportError(err, t("agents.createFailed")));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title={t("agents.new")}
      error={error}
      onSubmit={submit}
      submitLabel={t("agents.create")}
      submitting={submitting}
    >
      <TextInput
        label={t("agents.name")}
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        onBlur={() => setName(toSlug(name))}
        placeholder={t("agents.namePlaceholder")}
        required
        description={t("agents.nameHint")}
        inputWrapperOrder={["label", "input", "description", "error"]}
      />
      <TextInput
        label={t("agents.displayName")}
        value={displayName}
        onChange={(e) => setDisplayName(e.currentTarget.value)}
        placeholder={t("agents.displayNamePlaceholder")}
      />
      <Textarea
        label={t("agents.description")}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
        autosize
        minRows={3}
        maxRows={12}
        description={t("agents.descriptionHint")}
        inputWrapperOrder={["label", "input", "description", "error"]}
      />
      <TextInput
        label={t("agents.departmentCode")}
        value={departmentCode}
        onChange={(e) => setDepartmentCode(e.currentTarget.value)}
        placeholder="ENG"
        description={t("agents.departmentHint")}
      />
    </FormModal>
  );
}
