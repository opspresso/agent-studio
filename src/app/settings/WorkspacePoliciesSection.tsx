"use client";

import { useEffect, useState } from "react";
import { Alert, Card, Select, Stack, Text, Title } from "@mantine/core";
import { readJson } from "@/app/_lib/httpClient";
import { useT } from "@/app/_i18n/provider";
import { WorkspaceRepositoryPolicySection } from "@/app/workspaces/_components/WorkspaceRepositoryPolicySection";
import type { WorkspaceOptionsResponse } from "@/app/api/workspaces/options/route";

export function WorkspacePoliciesSection() {
  const t = useT();
  const [options, setOptions] = useState<WorkspaceOptionsResponse | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void fetch("/api/workspaces/options").then(response => readJson<WorkspaceOptionsResponse>(response)).then(data => {
      if (current) { setOptions(data); setProject(data.projects[0]?.projectName ?? null); }
    }).catch(error => { if (current) setError(error instanceof Error ? error.message : "Workspace options could not be loaded"); });
    return () => { current = false; };
  }, []);
  return <Card component="section" id="workspaces"><Stack gap="md">
    <Title order={2} size="h4">{t("workspace.policy.title")}</Title>
    {error && <Alert color="red">{error}</Alert>}
    {options && !options.projects.length && <Text size="sm">{t("workspace.notConfigured")}</Text>}
    <Select label={t("chat.project")} value={project} searchable data={(options?.projects ?? []).map(item => ({ value: item.projectName, label: item.displayName }))} onChange={setProject} />
    {project && <WorkspaceRepositoryPolicySection key={project} projectName={project} />}
  </Stack></Card>;
}
