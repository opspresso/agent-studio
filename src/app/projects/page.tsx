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
import { IconFolder } from "@tabler/icons-react";
import { FormModal } from "@/app/_components/FormModal";
import { useDisclosure } from "@mantine/hooks";
import { useSession } from "@/lib/auth-client";
import { tierMayCreateProjects } from "@/domain/member/tiers";
import { useViewer } from "@/app/_lib/useViewer";
import { toSlug } from "@/domain/naming";
import { useT } from "@/app/_i18n/provider";
import { OwnerLine } from "@/app/_components/OwnerLine";
import { createProject, listProjects, type SanitizedProject } from "./lib/api";
import { CardGrid } from "@/app/_components/CardGrid";
import { CatalogSearch, matchesFilter } from "@/app/_components/CatalogSearch";
import { CatalogHeader } from "@/app/_components/CatalogHeader";
import { reportError } from "@/app/_lib/reportError";
import { createLatestOnly } from "@/app/_lib/latestOnly";

export default function ProjectsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useT();
  const { data: session } = useSession();
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
      if (isCurrent()) setError(e instanceof Error ? e.message : t("projects.loadFailed"));
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
      router.replace("/projects", { scroll: false });
    }
  }, [createRequested, mayCreate, open, router]);

  const visibleProjects = projects.filter((project) =>
    matchesFilter(filter, project.displayName, project.name, project.description),
  );

  return (
    <Stack gap="lg">
      <CatalogHeader
        title={t("nav.projects")}
        description={t("projects.lede")}
        Icon={IconFolder}
      >
        {mayCreate && (
          <Button onClick={open}>{t("projects.new")}</Button>
        )}
      </CatalogHeader>

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
            placeholder={t("projects.filter")}
            resultCount={visibleProjects.length}
            totalCount={projects.length}
            onReset={filter ? () => setFilter("") : undefined}
          />
        </Group>
      )}

      <CardGrid
        loading={loading}
        empty={visibleProjects.length === 0}
        emptyText={t(projects.length === 0 ? "projects.empty" : "catalog.noResults")}
      >
        {visibleProjects.map((project) => (
          <Card
            key={project.name}
            component={Link}
            href={`/projects/${project.name}`}
            h="100%"
          >
            <Group justify="space-between" gap="xs" wrap="nowrap">
              <Text fw={500} truncate>
                {project.displayName || project.name}
              </Text>
              <Group gap={6} wrap="nowrap">
                {project.visibility === "private" && (
                  <Badge variant="light" color="gray">
                    {t("projects.privateBadge")}
                  </Badge>
                )}
              </Group>
            </Group>
            <Text ff="monospace" fz="xs" c="dimmed" mt={2}>
              {project.name}
            </Text>
            <OwnerLine
              ownerEmail={project.ownerEmail}
              isMine={session?.user.email === project.ownerEmail}
              mt={4}
            />
            <Text fz="sm" c="dimmed" mt="xs" lineClamp={3}>
              {project.description}
            </Text>
            {project.publishedVersion && (
              <Text fz="xs" c="light-dark(var(--mantine-color-teal-9), var(--mantine-color-teal-3))" mt="sm">
                {t("projects.published", { version: project.publishedVersion })}
              </Text>
            )}
          </Card>
        ))}
      </CardGrid>

      <CreateProjectModal
        opened={opened}
        onClose={close}
        onCreated={(createdName) => {
          close();
          // Straight to the playground: the initial version is already there,
          // so the next step is writing the prompt, not finding the card.
          router.push(`/projects/${createdName}`);
        }}
      />
    </Stack>
  );
}

function CreateProjectModal({
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
   * mount — so the draft that just became a project is still here when the next
   * "New project" opens.
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
        projectType: "agent",
        departmentCode: departmentCode || undefined,
      });
      reset();
      onCreated(project.name);
    } catch (err) {
      setError(reportError(err, t("projects.createFailed")));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title={t("projects.new")}
      error={error}
      onSubmit={submit}
      submitLabel={t("projects.create")}
      submitting={submitting}
    >
      <TextInput
        label={t("projects.name")}
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        onBlur={() => setName(toSlug(name))}
        placeholder={t("projects.namePlaceholder")}
        required
        description={t("projects.nameHint")}
        inputWrapperOrder={["label", "input", "description", "error"]}
      />
      <TextInput
        label={t("projects.displayName")}
        value={displayName}
        onChange={(e) => setDisplayName(e.currentTarget.value)}
        placeholder={t("projects.displayNamePlaceholder")}
      />
      <Textarea
        label={t("projects.description")}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
        autosize
        minRows={3}
        maxRows={12}
        description={t("projects.descriptionHint")}
        inputWrapperOrder={["label", "input", "description", "error"]}
      />
      <TextInput
        label={t("projects.departmentCode")}
        value={departmentCode}
        onChange={(e) => setDepartmentCode(e.currentTarget.value)}
        placeholder="ENG"
        description={t("projects.departmentHint")}
      />
    </FormModal>
  );
}
