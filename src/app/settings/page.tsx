"use client";

import { useEffect, useState } from "react";
import { CopyButton } from "@/app/_components/CopyButton";
import { Alert, Button, Card, Code, Group, Stack, Text, Title } from "@mantine/core";
import { BADGE } from "@/app/_components/badgeColors";
import { ProviderEditor, type ProviderRow } from "./ProviderEditor";
import { SettingField } from "./SettingField";

type SettingSource = "override" | "env" | "default" | "unset";

interface SettingFieldView {
  value: string;
  source: SettingSource;
  secret: boolean;
}

interface SettingsView {
  fields: Record<string, SettingFieldView>;
  llmProviders: { source: "override" | "env"; items: ProviderRow[] };
  updatedAt?: string;
}

interface FieldDef {
  key: string;
  label: string;
  placeholder?: string;
  /** Renders a Select instead of a text box, for a setting with a closed set of values. */
  options?: readonly string[];
}

interface SectionDef {
  title: string;
  fields: FieldDef[];
}

const SECTIONS: SectionDef[] = [
  {
    title: "General",
    fields: [
      { key: "publicBaseUrl", label: "PUBLIC_BASE_URL", placeholder: "https://studio.example.com" },
    ],
  },
  {
    title: "Access",
    fields: [
      { key: "adminEmails", label: "ADMIN_EMAILS", placeholder: "admin@example.com, ops@example.com" },
      { key: "allowedEmailDomains", label: "ALLOWED_EMAIL_DOMAINS", placeholder: "example.com" },
    ],
  },
  {
    title: "LLM",
    fields: [
      { key: "llmBaseUrl", label: "LLM_BASE_URL", placeholder: "https://api.openai.com/v1" },
      { key: "llmApiKey", label: "LLM_API_KEY" },
      {
        key: "unknownModelPolicy",
        label: "UNKNOWN_MODEL_POLICY",
        options: ["allow", "refuse"],
      },
    ],
  },
  {
    // One section because the token is shared: both syncs read GITHUB_TOKEN.
    title: "GitHub repos",
    fields: [
      { key: "skillsRepo", label: "SKILLS_REPO", placeholder: "opspresso/agent-skills" },
      { key: "skillsRepoBranch", label: "SKILLS_REPO_BRANCH", placeholder: "main" },
      { key: "toolsRepo", label: "TOOLS_REPO", placeholder: "opspresso/agent-tools" },
      { key: "toolsRepoBranch", label: "TOOLS_REPO_BRANCH", placeholder: "main" },
      { key: "githubToken", label: "GITHUB_TOKEN" },
    ],
  },
  {
    title: "A2A",
    fields: [{ key: "a2aApiKey", label: "A2A_API_KEY" }],
  },
];

/** Where a value came from — the owned colour marks the one the DB owns. */
const SOURCE_LABELS: Record<SettingSource, { text: string; color: string }> = {
  override: { text: "override", color: BADGE.owned },
  env: { text: "env", color: BADGE.neutral },
  default: { text: "default", color: BADGE.neutral },
  unset: { text: "not set", color: BADGE.neutral },
};


export default function SettingsPage() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [providersDirty, setProvidersDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  /** Raw A2A key, held only until the page is left — it is masked from then on. */
  // The plaintext A2A key, either just issued or read back on request. Held in
  // component state only, so leaving the page hides it again.
  const [a2aKeyShown, setA2aKeyShown] = useState<string | null>(null);
  const [a2aKeyFreshlyIssued, setA2aKeyFreshlyIssued] = useState(false);
  const [issuingA2aKey, setIssuingA2aKey] = useState(false);

  function applyView(next: SettingsView) {
    setView(next);
    setValues(Object.fromEntries(Object.entries(next.fields).map(([k, f]) => [k, f.value])));
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
        const res = await fetch("/api/settings");
        if (res.status === 403) {
          if (!cancelled) {
            setForbidden(true);
          }
          return;
        }
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`);
        }
        const data = (await res.json()) as SettingsView;
        if (!cancelled) {
          applyView(data);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load settings");
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

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, ...(providersDirty ? { llmProviders: providers } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as SettingsView & { error?: string };
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

  async function issueA2aKey(replacing: boolean) {
    if (
      replacing &&
      !confirm("Generate a new A2A_API_KEY? The current key stops working immediately.")
    ) {
      return;
    }
    setIssuingA2aKey(true);
    setError(null);
    setA2aKeyShown(null);
    try {
      const res = await fetch("/api/settings/a2a-key", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        key?: string;
        view?: SettingsView;
        error?: string;
      };
      if (!res.ok || !data.key || !data.view) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      setA2aKeyShown(data.key);
      setA2aKeyFreshlyIssued(true);
      applyView(data.view);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate A2A key");
    } finally {
      setIssuingA2aKey(false);
    }
  }

  /** Read the effective key back in plaintext (stored override decrypted, or env). */
  async function revealA2aKey() {
    setIssuingA2aKey(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/a2a-key/reveal", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { key?: string; error?: string };
      if (!res.ok || !data.key) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      setA2aKeyShown(data.key);
      setA2aKeyFreshlyIssued(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reveal A2A key");
    } finally {
      setIssuingA2aKey(false);
    }
  }

  if (loading) {
    return (
      <Text fz="sm" c="dimmed">
        Loading…
      </Text>
    );
  }

  if (forbidden) {
    return (
      <Alert variant="light" color="gray" maw={640}>
        Only admins can access app settings.
      </Alert>
    );
  }

  return (
    <Stack gap="lg" maw={860}>
      <div>
        <Title order={1} fz="h2">
          Settings
        </Title>
        <Text fz="sm" c="dimmed" mt={4}>
          Overrides are stored in the database and take precedence over environment variables.
          Masked values keep the stored secret; clear a field to fall back to env.
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
                    badge={SOURCE_LABELS[view?.fields[field.key]?.source ?? "unset"]}
                    value={values[field.key] ?? ""}
                    onChange={(value) => setValues((prev) => ({ ...prev, [field.key]: value }))}
                    {...(field.placeholder ? { placeholder: field.placeholder } : {})}
                    {...(field.options ? { options: field.options } : {})}
                  />
                ))}

                {section.title === "A2A" && (
                  <Stack gap="xs">
                    {a2aKeyShown && (
                      <Alert color="yellow" variant="light" p="sm">
                        <Group gap="xs" wrap="nowrap">
                          <Code style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                            {a2aKeyShown}
                          </Code>
                          <CopyButton text={a2aKeyShown} />
                          <Button
                            variant="default"
                            size="compact-xs"
                            onClick={() => setA2aKeyShown(null)}
                          >
                            Hide
                          </Button>
                        </Group>
                        <Text fz="xs" mt={4}>
                          {a2aKeyFreshlyIssued
                            ? "This key is now live; the previous one stopped working. "
                            : ""}
                          Inbound A2A callers must send it as <Code>X-A2A-Key</Code>.
                        </Text>
                      </Alert>
                    )}
                    <Group gap="xs" wrap="wrap">
                      <Button
                        variant="default"
                        size="compact-sm"
                        onClick={() => issueA2aKey(view?.fields.a2aApiKey?.source !== "unset")}
                        loading={issuingA2aKey}
                      >
                        {view?.fields.a2aApiKey?.source === "unset"
                          ? "Generate key"
                          : "Regenerate key"}
                      </Button>
                      {view?.fields.a2aApiKey?.source !== "unset" && !a2aKeyShown && (
                        <Button
                          variant="default"
                          size="compact-sm"
                          onClick={revealA2aKey}
                          disabled={issuingA2aKey}
                        >
                          Reveal key
                        </Button>
                      )}
                    </Group>
                    <Text fz="xs" c="dimmed">
                      Generating stores the key as an override. The key is kept encrypted, so
                      &ldquo;Reveal key&rdquo; can show it again later. You can also paste a key of
                      your own into the field above.
                    </Text>
                  </Stack>
                )}

                {section.title === "LLM" && (
                  <ProviderEditor
                    rows={providers}
                    onChange={editProviders}
                    badge={
                      SOURCE_LABELS[
                        providersDirty || view?.llmProviders.source === "override"
                          ? "override"
                          : "env"
                      ]
                    }
                    hint="Saving an edited list stores it as an override; removing every row falls back to the LLM_PROVIDER_* env variables."
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
