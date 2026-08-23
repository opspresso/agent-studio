"use client";

import { useEffect, useState } from "react";
import { CopyButton } from "@/app/_components/CopyButton";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconSettings } from "@tabler/icons-react";
import { monoInput } from "@/app/_components/monoInput";
import { PageHeader } from "@/app/_components/PageHeader";
import { LoadingText } from "@/app/_components/PageState";
import { useConfirm } from "@/app/_components/useConfirm";
import { BADGE } from "@/app/_components/badgeColors";
import { SUPPORTED_PROVIDERS } from "@/domain/llm/models";
import { A2aClientKeysSection } from "./A2aClientKeysSection";
import { useT } from "@/app/_i18n/provider";
import { reportError } from "@/app/_lib/reportError";


type SettingSource = "override" | "env" | "default" | "unset";

interface SettingFieldView {
  value: string;
  source: SettingSource;
  secret: boolean;
}

interface LlmProviderRow {
  name: string;
  baseUrl: string;
  apiKey: string;
  keepModelPrefix: boolean;
  auth: "bearer" | "sigv4";
}

interface SettingsView {
  fields: Record<string, SettingFieldView>;
  llmProviders: { source: "override" | "env"; items: LlmProviderRow[] };
  updatedAt?: string;
}

interface FieldDef {
  key: string;
  label: string;
  placeholder?: string;
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
      { key: "artifactAccessMode", label: "ARTIFACT_ACCESS_MODE" },
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
        placeholder: "allow | refuse",
      },
    ],
  },
  {
    title: "Plugins repo",
    fields: [
      { key: "pluginsRepo", label: "PLUGINS_REPO", placeholder: "opspresso/agent-plugins" },
      { key: "pluginsRepoBranch", label: "PLUGINS_REPO_BRANCH", placeholder: "main" },
      { key: "githubToken", label: "GITHUB_TOKEN" },
    ],
  },
  {
    title: "A2A",
    fields: [{ key: "a2aApiKey", label: "A2A_API_KEY" }],
  },
];

/**
 * The picker reads the registry's provider list rather than restating it: this
 * was a second copy, and it was already the stale one — a provider the API
 * accepts but the console cannot offer is a channel nobody can configure here.
 * `domain/` is pure TS and safe in a client bundle, which is what makes the
 * single owner reachable from a `"use client"` file at all.
 */
const PROVIDER_OPTIONS = SUPPORTED_PROVIDERS;

/** SigV4 carries no key — the row's key field goes away when it is picked. */
const AUTH_OPTIONS = ["bearer", "sigv4"] as const;

/** Where a value came from — the owned colour marks the one the DB owns. */
const SOURCE_LABELS: Record<SettingSource, { text: string; color: string }> = {
  override: { text: "override", color: BADGE.owned },
  env: { text: "env", color: BADGE.neutral },
  default: { text: "default", color: BADGE.neutral },
  unset: { text: "not set", color: BADGE.neutral },
};


export default function SettingsPage() {
  const t = useT();
  const [view, setView] = useState<SettingsView | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [providers, setProviders] = useState<LlmProviderRow[]>([]);
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

  function editProviders(update: (prev: LlmProviderRow[]) => LlmProviderRow[]) {
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
      setError(reportError(err, "Failed to save"));
    } finally {
      setSaving(false);
    }
  }

  const { confirm, confirmModal } = useConfirm();

  async function issueA2aKey(replacing: boolean) {
    if (
      replacing &&
      !(await confirm({
        title: "Generate a new A2A_API_KEY",
        message: "The current key stops working immediately.",
        confirmLabel: "Generate",
      }))
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
      setError(reportError(err, "Failed to generate A2A key"));
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
      setError(reportError(err, "Failed to reveal A2A key"));
    } finally {
      setIssuingA2aKey(false);
    }
  }

  if (loading) {
    return <LoadingText />;
  }

  if (forbidden) {
    return (
      <Alert variant="light" color="gray" maw={640}>
        Only admins can access app settings.
      </Alert>
    );
  }

  // A cap in pixels, not a share of the row. A fraction is for a row two
  // columns divide — the playground's form and preview — and this page has one
  // column with a floor: the LLM provider row carries six controls and wraps
  // below roughly 830px, which 8/12 drops under as soon as the window is
  // narrower than a wide monitor. A cap grows to the window and stops, so the
  // page is never narrower than it has to be, and the single-line fields never
  // stretch across a 1500px display.
  return (
    <Stack gap="lg" maw={1000}>
      <PageHeader
        title={t("nav.settings")}
        description={t("settings.lede")}
        Icon={IconSettings}
      />
      {confirmModal}

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
                {section.fields.map((field) => {
                  const meta = view?.fields[field.key];
                  const source = SOURCE_LABELS[meta?.source ?? "unset"];
                  if (field.key === "artifactAccessMode") {
                    return (
                      <Select
                        key={field.key}
                        label={
                          <Group component="span" gap="xs">
                            <Text component="span" ff="monospace" fz="sm" fw={500}>
                              {field.label}
                            </Text>
                            <Badge color={source.color}>{source.text}</Badge>
                          </Group>
                        }
                        value={values[field.key] ?? "authenticated"}
                        onChange={(value) =>
                          setValues((prev) => ({
                            ...prev,
                            [field.key]: value ?? "authenticated",
                          }))
                        }
                        allowDeselect={false}
                        data={[
                          { value: "authenticated", label: t("settings.artifactAccess.authenticated") },
                          { value: "public", label: t("settings.artifactAccess.public") },
                          { value: "proxied", label: t("settings.artifactAccess.proxied") },
                        ]}
                        styles={monoInput}
                      />
                    );
                  }
                  return (
                    <TextInput
                      key={field.key}
                      label={
                        <Group component="span" gap="xs">
                          <Text component="span" ff="monospace" fz="sm" fw={500}>
                            {field.label}
                          </Text>
                          <Badge color={source.color}>{source.text}</Badge>
                        </Group>
                      }
                      value={values[field.key] ?? ""}
                      onChange={(e) => {
                        // Read now, not inside the updater: React nulls a
                        // synthetic event's `currentTarget` once the handler
                        // returns, and an updater runs on the next render.
                        const value = e.currentTarget.value;
                        setValues((prev) => ({ ...prev, [field.key]: value }));
                      }}
                      placeholder={field.placeholder}
                      styles={monoInput}
                    />
                  );
                })}

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
                    <A2aClientKeysSection />
                  </Stack>
                )}

                {section.title === "LLM" && (
                  <Stack gap="sm">
                    <Group gap="xs">
                      <Text ff="monospace" fz="sm" fw={500}>
                        LLM_PROVIDER_*
                      </Text>
                      <Badge
                        color={
                          SOURCE_LABELS[
                            providersDirty || view?.llmProviders.source === "override"
                              ? "override"
                              : "env"
                          ].color
                        }
                      >
                        {providersDirty || view?.llmProviders.source === "override"
                          ? "override"
                          : "env"}
                      </Badge>
                    </Group>
                    {providers.map((provider, index) => (
                      <Group key={index} gap="xs" wrap="wrap" align="center">
                        <Select
                          value={provider.name}
                          onChange={(value) =>
                            editProviders((prev) =>
                              prev.map((p, i) => (i === index ? { ...p, name: value ?? "" } : p)),
                            )
                          }
                          placeholder={t("settings.providerPlaceholder")}
                          allowDeselect={false}
                          data={[...PROVIDER_OPTIONS]}
                          w={144}
                          styles={monoInput}
                        />
                        <TextInput
                          value={provider.baseUrl}
                          onChange={(e) => {
                            const baseUrl = e.currentTarget.value;
                            editProviders((prev) =>
                              prev.map((p, i) => (i === index ? { ...p, baseUrl } : p)),
                            );
                          }}
                          placeholder={t("settings.baseUrlPlaceholder")}
                          miw={192}
                          style={{ flex: 1 }}
                          styles={monoInput}
                        />
                        <Select
                          value={provider.auth}
                          onChange={(value) =>
                            editProviders((prev) =>
                              prev.map((p, i) =>
                                i === index
                                  ? { ...p, auth: value === "sigv4" ? "sigv4" : "bearer" }
                                  : p,
                              ),
                            )
                          }
                          allowDeselect={false}
                          data={[...AUTH_OPTIONS]}
                          w={112}
                          styles={monoInput}
                        />
                        <TextInput
                          value={provider.auth === "sigv4" ? "" : provider.apiKey}
                          onChange={(e) => {
                            const apiKey = e.currentTarget.value;
                            editProviders((prev) =>
                              prev.map((p, i) => (i === index ? { ...p, apiKey } : p)),
                            );
                          }}
                          // A signed channel has no key to hold: AWS credentials
                          // come from the pod's own identity, so the field says
                          // so rather than accepting a value nothing would send.
                          disabled={provider.auth === "sigv4"}
                          placeholder={provider.auth === "sigv4" ? "AWS credentials" : "API key"}
                          w={176}
                          styles={monoInput}
                        />
                        <Checkbox
                          size="xs"
                          label={t("settings.keepPrefix")}
                          checked={provider.keepModelPrefix}
                          onChange={(e) => {
                            const keepModelPrefix = e.currentTarget.checked;
                            editProviders((prev) =>
                              prev.map((p, i) => (i === index ? { ...p, keepModelPrefix } : p)),
                            );
                          }}
                        />
                        <Button
                          variant="default"
                          size="compact-sm"
                          onClick={() =>
                            editProviders((prev) => prev.filter((_, i) => i !== index))
                          }
                        >
                          Remove
                        </Button>
                      </Group>
                    ))}
                    <Button
                      variant="default"
                      size="compact-sm"
                      style={{ alignSelf: "flex-start" }}
                      onClick={() =>
                        editProviders((prev) => [
                          ...prev,
                          { name: "", baseUrl: "", apiKey: "", keepModelPrefix: false, auth: "bearer" },
                        ])
                      }
                    >
                      Add provider
                    </Button>
                    <Text fz="xs" c="dimmed">
                      Saving an edited list stores it as an override; removing every row falls back
                      to the LLM_PROVIDER_* env variables.
                    </Text>
                  </Stack>
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
