"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Modal,
  Stack,
  Text,
  Textarea,
  TextInput,
  Select,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useSession } from "@/lib/auth-client";
import { toSlug } from "@/shared/slug";
import { OwnerLine } from "@/app/_components/OwnerLine";
import { createProject, listProjects, type Project, type ProjectType } from "./lib/api";
import { CardGrid } from "@/app/_components/CardGrid";
import { PROJECT_TYPE_COLOR } from "@/app/_components/badgeColors";

const TYPE_OPTIONS = [
  { value: "llm", label: "llm — single-shot prompt" },
  { value: "agent", label: "agent — multi-turn tool loop" },
  { value: "image", label: "image — image generation" },
];

export default function ProjectsPage() {
  const { data: session } = useSession();
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
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={1} fz="h2">
            Projects
          </Title>
          <Text fz="sm" c="dimmed" mt={4}>
            Prompt and agent projects with versioned configuration.
          </Text>
        </div>
        <Button onClick={open}>New project</Button>
      </Group>

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
        onCreated={() => {
          close();
          void refresh();
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
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [projectType, setProjectType] = useState<ProjectType>("llm");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createProject({ name, displayName: displayName || name, description, projectType });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="New project" size="lg">
      <form onSubmit={submit}>
        <Stack gap="md">
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
          <Select
            label="Type"
            value={projectType}
            onChange={(value) => setProjectType((value ?? "llm") as ProjectType)}
            data={TYPE_OPTIONS}
            allowDeselect={false}
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
