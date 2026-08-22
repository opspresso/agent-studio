"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
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
  Select,
} from "@mantine/core";
import { IconFolder } from "@tabler/icons-react";
import { FormModal } from "@/app/_components/FormModal";
import { useDisclosure } from "@mantine/hooks";
import { useSession } from "@/lib/auth-client";
import { tierMayCreateProjects } from "@/domain/member/tiers";
import { useViewer } from "@/app/_lib/useViewer";
import { toSlug } from "@/domain/naming";
import type { MessageKey } from "@/app/_i18n/messages/en";
import { useT } from "@/app/_i18n/provider";
import { OwnerLine } from "@/app/_components/OwnerLine";
import { createProject, listProjects, type SanitizedProject, type ProjectType } from "./lib/api";
import { CardGrid } from "@/app/_components/CardGrid";
import { PROJECT_TYPE_COLOR } from "@/app/_components/badgeColors";
import { CatalogHeader } from "@/app/_components/CatalogHeader";
import { reportError } from "@/app/_lib/reportError";

const TYPE_OPTIONS = [
  { value: "llm", label: "projects.type.llm" },
  { value: "agent", label: "projects.type.agent" },
  { value: "image", label: "projects.type.image" },
] as const satisfies ReadonlyArray<{ value: ProjectType; label: MessageKey }>;

export default function ProjectsPage() {
  const router = useRouter();
  const t = useT();
  const { data: session } = useSession();
  const viewer = useViewer();
  const [projects, setProjects] = useState<SanitizedProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opened, { open, close }] = useDisclosure(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setProjects(await listProjects());
    } catch (e) {
      setError(e instanceof Error ? e.message : t("projects.loadFailed"));
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
        title={t("nav.projects")}
        description={t("projects.lede")}
        Icon={IconFolder}
      >
        {viewer !== null && tierMayCreateProjects(viewer.tier) && (
          <Button onClick={open}>{t("projects.new")}</Button>
        )}
      </CatalogHeader>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      <CardGrid
        loading={loading}
        empty={projects.length === 0}
        emptyText={t("projects.empty")}
      >
        {projects.map((project) => (
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
                <Badge color={PROJECT_TYPE_COLOR[project.projectType]}>{project.projectType}</Badge>
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
              <Text fz="xs" c="teal" mt="sm">
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
  const [projectType, setProjectType] = useState<ProjectType>("llm");
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
    setProjectType("llm");
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const project = await createProject({
        name,
        displayName: displayName || name,
        description,
        projectType,
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
      />
      <TextInput
        label={t("projects.departmentCode")}
        value={departmentCode}
        onChange={(e) => setDepartmentCode(e.currentTarget.value)}
        placeholder="ENG"
        description={t("projects.departmentHint")}
      />
      <Select
        label={t("projects.type")}
        value={projectType}
        onChange={(value) => setProjectType((value ?? "llm") as ProjectType)}
        data={TYPE_OPTIONS.map(({ value, label }) => ({ value, label: t(label) }))}
        allowDeselect={false}
      />
    </FormModal>
  );
}
