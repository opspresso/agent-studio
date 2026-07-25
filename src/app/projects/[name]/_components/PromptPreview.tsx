"use client";

import { useMemo, useState } from "react";
import { findTemplateVariables } from "@/application/llm/template";
import { previewPrompt, type PromptPreview, type VersionInput } from "../../lib/api";
import { inputClass } from "./inputs";

/** The whole assembled prompt as one block, for pasting elsewhere. */
function promptText(preview: PromptPreview): string {
  return preview.messages.map((message) => `[${message.role}]\n${message.content}`).join("\n\n");
}

function charCount(preview: PromptPreview): number {
  return preview.messages.reduce((total, message) => total + message.content.length, 0);
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * What this version would actually send.
 *
 * The editor shows the version's own text, but an agent run's system prompt is
 * assembled at dispatch — the skill table, the connected MCP servers and their
 * tool names, the transfer instructions — and a prompt project's template is
 * rendered with its variables. This panel asks the server to perform that same
 * assembly and shows the result.
 *
 * Fetched only on demand: it contacts the bound MCP servers for their real tool
 * names, which is not something to do on every keystroke. A draft edited after
 * the last fetch is marked stale rather than refetched.
 */
export function PromptPreview({
  projectName,
  draft,
}: {
  projectName: string;
  draft: VersionInput;
}) {
  const [preview, setPreview] = useState<PromptPreview | null>(null);
  const [previewOf, setPreviewOf] = useState<string>("");
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const varNames = useMemo(
    () => [...findTemplateVariables(`${draft.systemPrompt}\n${draft.userPromptTemplate}`)],
    [draft.systemPrompt, draft.userPromptTemplate],
  );
  const current = JSON.stringify({ draft, variables });
  const stale = preview !== null && previewOf !== current;

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const result = await previewPrompt(projectName, { ...draft, variables });
      setPreview(result);
      setPreviewOf(JSON.stringify({ draft, variables }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to build the preview");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          {preview && (
            <>
              <span>{charCount(preview).toLocaleString()} chars</span>
              {preview.toolNames.length > 0 && <span>· {preview.toolNames.length} tools</span>}
            </>
          )}
          {stale && <span className="text-amber-600 dark:text-amber-400">· stale</span>}
        </div>
        <div className="flex items-center gap-2">
          {preview && <CopyButton text={promptText(preview)} />}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading || !draft.model}
            className="rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-strong disabled:opacity-50"
          >
            {loading ? "Building…" : preview ? "Refresh" : "Build preview"}
          </button>
        </div>
      </div>

      {varNames.length > 0 && (
        <div className="space-y-2">
          <span className="text-sm font-medium">Variables</span>
          {varNames.map((name) => (
            <label key={name} className="flex items-center gap-2">
              <span className="w-32 shrink-0 font-mono text-xs text-neutral-500">{name}</span>
              <input
                value={variables[name] ?? ""}
                onChange={(e) => setVariables((prev) => ({ ...prev, [name]: e.target.value }))}
                className={inputClass}
              />
            </label>
          ))}
        </div>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {preview?.warnings.map((warning, index) => (
        <div
          key={`warning-${index}`}
          className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          ⚠️ {warning}
        </div>
      ))}

      {preview?.messages.map((message, index) => (
        <div key={`message-${index}`} className="space-y-1">
          <span className="font-mono text-xs uppercase tracking-wide text-neutral-500">
            {message.role}
          </span>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs leading-relaxed dark:border-neutral-800 dark:bg-neutral-900">
            {message.content}
          </pre>
        </div>
      ))}

      {preview && preview.messages.length === 0 && (
        <p className="text-xs text-neutral-400">
          This version sends no prompt of its own; the conversation supplies everything.
        </p>
      )}

      {preview && preview.toolNames.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-neutral-500">
            Tools offered ({preview.toolNames.length})
          </summary>
          <p className="mt-1 font-mono text-neutral-600 dark:text-neutral-400">
            {preview.toolNames.join(", ")}
          </p>
        </details>
      )}

      {!preview && !error && (
        <p className="text-xs text-neutral-400">
          Builds the system prompt the way a run does — skill table, connected MCP servers and
          their tool names, transfer instructions — by contacting the bound MCP servers.
        </p>
      )}
    </div>
  );
}
