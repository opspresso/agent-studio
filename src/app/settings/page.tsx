"use client";

import { useEffect, useState } from "react";

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
    ],
  },
  {
    title: "Slack",
    fields: [
      { key: "slackDefaultProject", label: "SLACK_DEFAULT_PROJECT" },
      { key: "slackBotToken", label: "SLACK_BOT_TOKEN" },
      { key: "slackSigningSecret", label: "SLACK_SIGNING_SECRET" },
    ],
  },
  {
    title: "Skills repo",
    fields: [
      { key: "skillsRepo", label: "SKILLS_REPO", placeholder: "opspresso/agent-skills" },
      { key: "skillsRepoBranch", label: "SKILLS_REPO_BRANCH", placeholder: "main" },
      { key: "githubToken", label: "GITHUB_TOKEN" },
    ],
  },
  {
    title: "A2A",
    fields: [{ key: "a2aApiKey", label: "A2A_API_KEY" }],
  },
  {
    title: "General",
    fields: [
      { key: "publicBaseUrl", label: "PUBLIC_BASE_URL", placeholder: "https://studio.example.com" },
    ],
  },
];

const PROVIDER_OPTIONS = ["openai", "anthropic", "google", "xai"] as const;

const SOURCE_LABELS: Record<SettingSource, { text: string; className: string }> = {
  override: {
    text: "override",
    className: "bg-brand/10 text-brand",
  },
  env: {
    text: "env",
    className: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
  },
  default: {
    text: "default",
    className: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400",
  },
  unset: {
    text: "not set",
    className: "bg-neutral-100 text-neutral-400 dark:bg-neutral-800 dark:text-neutral-500",
  },
};

const inputClass =
  "mt-1 w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none dark:border-neutral-700";

export default function SettingsPage() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [providers, setProviders] = useState<LlmProviderRow[]>([]);
  const [providersDirty, setProvidersDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

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
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-neutral-500">Loading…</p>;
  }

  if (forbidden) {
    return (
      <div className="max-w-xl rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
        Only admins can access app settings.
      </div>
    );
  }

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Overrides are stored in the database and take precedence over environment variables.
          Masked values (all asterisks) keep the stored secret; clear a field to fall back to env.
        </p>
      </div>

      <form onSubmit={save} className="space-y-8">
        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </div>
        )}

        {SECTIONS.map((section) => (
          <section
            key={section.title}
            className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
          >
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
              {section.title}
            </h2>
            {section.fields.map((field) => {
              const meta = view?.fields[field.key];
              const source = SOURCE_LABELS[meta?.source ?? "unset"];
              return (
                <label key={field.key} className="block">
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium">{field.label}</span>
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${source.className}`}>
                      {source.text}
                    </span>
                  </span>
                  <input
                    value={values[field.key] ?? ""}
                    onChange={(e) =>
                      setValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    placeholder={field.placeholder}
                    className={inputClass}
                  />
                </label>
              );
            })}
            {section.title === "LLM" && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium">LLM_PROVIDER_*</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                      SOURCE_LABELS[providersDirty || view?.llmProviders.source === "override" ? "override" : "env"].className
                    }`}
                  >
                    {providersDirty || view?.llmProviders.source === "override" ? "override" : "env"}
                  </span>
                </div>
                {providers.map((provider, index) => (
                  <div key={index} className="flex flex-wrap items-center gap-2">
                    <select
                      value={provider.name}
                      onChange={(e) =>
                        editProviders((prev) =>
                          prev.map((p, i) => (i === index ? { ...p, name: e.target.value } : p)),
                        )
                      }
                      className="w-36 rounded-md border border-neutral-300 bg-transparent px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none dark:border-neutral-700 dark:bg-neutral-950"
                    >
                      {provider.name === "" && <option value="">provider…</option>}
                      {PROVIDER_OPTIONS.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                    <input
                      value={provider.baseUrl}
                      onChange={(e) =>
                        editProviders((prev) =>
                          prev.map((p, i) => (i === index ? { ...p, baseUrl: e.target.value } : p)),
                        )
                      }
                      placeholder="base URL"
                      className="min-w-48 flex-1 rounded-md border border-neutral-300 bg-transparent px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none dark:border-neutral-700"
                    />
                    <input
                      value={provider.apiKey}
                      onChange={(e) =>
                        editProviders((prev) =>
                          prev.map((p, i) => (i === index ? { ...p, apiKey: e.target.value } : p)),
                        )
                      }
                      placeholder="API key"
                      className="w-44 rounded-md border border-neutral-300 bg-transparent px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none dark:border-neutral-700"
                    />
                    <label className="flex items-center gap-1.5 text-xs text-neutral-500">
                      <input
                        type="checkbox"
                        checked={provider.keepModelPrefix}
                        onChange={(e) =>
                          editProviders((prev) =>
                            prev.map((p, i) =>
                              i === index ? { ...p, keepModelPrefix: e.target.checked } : p,
                            ),
                          )
                        }
                      />
                      keep prefix
                    </label>
                    <button
                      type="button"
                      onClick={() => editProviders((prev) => prev.filter((_, i) => i !== index))}
                      className="rounded-md border border-neutral-300 px-2 py-1.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    editProviders((prev) => [
                      ...prev,
                      { name: "", baseUrl: "", apiKey: "", keepModelPrefix: false },
                    ])
                  }
                  className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
                >
                  Add provider
                </button>
                <p className="text-xs text-neutral-400">
                  Saving an edited list stores it as an override; removing every row falls back
                  to the LLM_PROVIDER_* env variables.
                </p>
              </div>
            )}
          </section>
        ))}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-strong disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
          {saved && <span className="text-sm text-emerald-600 dark:text-emerald-400">Saved</span>}
        </div>
      </form>
    </div>
  );
}
