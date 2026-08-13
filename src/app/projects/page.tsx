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
import { toSlug } from "@/shared/slug";
import { OwnerLine } from "@/app/_components/OwnerLine";
import { createProject, listProjects, type Project, type ProjectType } from "./lib/api";
import { CardGrid } from "@/app/_components/CardGrid";
import { PROJECT_TYPE_COLOR } from "@/app/_components/badgeColors";
import { CatalogHeader } from "@/app/_components/CatalogHeader";

const TYPE_OPTIONS = [
  { value: "llm", label: "llm — single-shot prompt" },
  { value: "agent", label: "agent — multi-turn tool loop" },
  { value: "image", label: "image — generate or edit images" },
];

export default function ProjectsPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const viewer = useViewer();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opened, { open, close }] = useDisclosure(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setProjects(await listProjects());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load projects");
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
        title="Projects"
        description="Prompt, agent, and image projects — iterate in versions, publish one for callers."
        Icon={IconFolder}
      >
        {viewer !== null && (viewer.isAdmin || tierMayCreateProjects(viewer.tier)) && (
          <Button onClick={open}>New project</Button>
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
        emptyText="No projects yet. Create your first one."
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
              <Badge color={PROJECT_TYPE_COLOR[project.projectType]}>{project.projectType}</Badge>
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
                published: v{project.publishedVersion}
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
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FormModal
      opened={opened}
      onClose={onClose}
      title="New project"
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
        placeholder="my-project"
        required
        description="Lowercase letters, digits, and hyphens only. Immutable identifier."
        inputWrapperOrder={["label", "input", "description", "error"]}
      />
      <TextInput
        label="Display name"
        value={displayName}
        onChange={(e) => setDisplayName(e.currentTarget.value)}
        placeholder="My Project"
      />
      <Textarea
        label="Description"
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
        autosize
        minRows={3}
        maxRows={12}
      />
      <TextInput
        label="Department code"
        value={departmentCode}
        onChange={(e) => setDepartmentCode(e.currentTarget.value)}
        placeholder="ENG"
        description="Optional code used to group project ownership and costs."
      />
      <Select
        label="Type"
        value={projectType}
        onChange={(value) => setProjectType((value ?? "llm") as ProjectType)}
        data={TYPE_OPTIONS}
        allowDeselect={false}
      />
    </FormModal>
  );
}
