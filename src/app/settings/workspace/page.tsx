"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { BADGE } from "@/app/_components/badgeColors";
import { ProviderEditor, type ProviderRow } from "../ProviderEditor";
import { SettingField } from "../SettingField";

/**
 * What this workspace decides for itself, over the deployment's answer.
 *
 * A short list on purpose (`TENANT_OVERRIDABLE_KEYS`): bring-your-own model
 * access, this workspace's own skill and tool sources, and whether it runs
 * models it cannot price. Everything else is either infrastructure the process
 * is bound to or answered by membership instead — `ADMIN_EMAILS` inside a
 * workspace is its members, not a string.
 */
type FieldSource = "workspace" | "inherited";

interface WorkspaceSettingsView {
  tenant: string;
  fields: Record<string, { value: string; source: FieldSource; secret: boolean }>;
  llmProviders: { source: FieldSource; items: ProviderRow[] };
  updatedAt?: string;
}

interface FieldDef {
  key: string;
  label: string;
  placeholder?: string;
  options?: readonly string[];
}

const SECTIONS: { title: string; fields: FieldDef[] }[] = [
  {
    title: "LLM",
    fields: [
      { key: "llmBaseUrl", label: "LLM_BASE_URL", placeholder: "https://api.openai.com/v1" },
      { key: "llmApiKey", label: "LLM_API_KEY" },
      { key: "unknownModelPolicy", label: "UNKNOWN_MODEL_POLICY", options: ["allow", "refuse"] },
    ],
  },
  {
    title: "GitHub repos",
    fields: [
      { key: "skillsRepo", label: "SKILLS_REPO", placeholder: "opspresso/agent-skills" },
      { key: "skillsRepoBranch", label: "SKILLS_REPO_BRANCH", placeholder: "main" },
      { key: "toolsRepo", label: "TOOLS_REPO", placeholder: "opspresso/agent-tools" },
      { key: "toolsRepoBranch", label: "TOOLS_REPO_BRANCH", placeholder: "main" },
      { key: "githubToken", label: "GITHUB_TOKEN" },
    ],
  },
];

/** The workspace's own answer is the one it owns; the rest comes from below. */
const SOURCE_LABELS: Record<FieldSource, { text: string; color: string }> = {
  workspace: { text: "workspace", color: BADGE.owned },
  inherited: { text: "inherited", color: BADGE.neutral },
};

export default function WorkspaceSettingsPage() {
  const [view, setView] = useState<WorkspaceSettingsView | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [providersDirty, setProvidersDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refused, setRefused] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function applyView(next: WorkspaceSettingsView) {
    setView(next);
    setValues(Object.fromEntries(Object.entries(next.fields).map(([key, f]) => [key, f.value])));
    setProviders(next.llmProviders.items);
    setProvidersDirty(false);
  }

  function editProviders(update: (prev: ProviderRow[]) => ProviderRow[]) {
    setProviders(update);
    setProvidersDirty(true);
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/settings/workspace");
        const data = (await res.json().catch(() => ({}))) as WorkspaceSettingsView & {
          error?: string;
        };
        if (cancelled) {
          return;
        }
        if (!res.ok) {
          // 403 (not this workspace's admin) and 400 (the default workspace has
          // no settings of its own) are both "this page is not for you", and
          // the server already says which.
          setRefused(data.error ?? `Request failed (${res.status})`);
          return;
        }
        applyView(data);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load workspace settings");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/settings/workspace", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, ...(providersDirty ? { llmProviders: providers } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as WorkspaceSettingsView & {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      applyView(data);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Text fz="sm" c="dimmed">
        Loading…
      </Text>
    );
  }

  if (refused) {
    return (
      <Alert variant="light" color="gray" maw={640}>
        {refused}
      </Alert>
    );
  }

  return (
    <Stack gap="lg" maw={860}>
      <div>
        <Title order={1} fz="h2">
          Workspace settings
        </Title>
        <Text fz="sm" c="dimmed" mt={4}>
          Decisions for <Text component="span" ff="monospace">{view?.tenant}</Text> alone. They sit
          above the deployment&rsquo;s settings; clear a field to inherit that answer again. Masked
          values keep the stored secret.
        </Text>
      </div>

      <form onSubmit={save}>
        <Stack gap="xl">
          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}

          {SECTIONS.map((section) => (
            <Card key={section.title} component="section">
              <Stack gap="md">
                <Text fz="sm" fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: "0.05em" }}>
                  {section.title}
                </Text>
                {section.fields.map((field) => (
                  <SettingField
                    key={field.key}
                    label={field.label}
                    badge={SOURCE_LABELS[view?.fields[field.key]?.source ?? "inherited"]}
                    value={values[field.key] ?? ""}
                    onChange={(value) => setValues((prev) => ({ ...prev, [field.key]: value }))}
                    {...(field.placeholder ? { placeholder: field.placeholder } : {})}
                    {...(field.options ? { options: field.options } : {})}
                  />
                ))}

                {section.title === "LLM" && (
                  <ProviderEditor
                    rows={providers}
                    onChange={editProviders}
                    badge={
                      SOURCE_LABELS[
                        providersDirty || view?.llmProviders.source === "workspace"
                          ? "workspace"
                          : "inherited"
                      ]
                    }
                    hint="Saving an edited list replaces the deployment's providers for this workspace; removing every row inherits them again."
                  />
                )}
              </Stack>
            </Card>
          ))}

          <Group gap="sm">
            <Button type="submit" loading={saving}>
              Save changes
            </Button>
            {saved && (
              <Text fz="sm" c="teal">
                Saved
              </Text>
            )}
          </Group>
        </Stack>
      </form>
    </Stack>
  );
}
