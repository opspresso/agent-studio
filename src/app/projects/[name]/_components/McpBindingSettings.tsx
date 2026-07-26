"use client";

/**
 * Everything configurable about one bound MCP server, in one place.
 *
 * The three sections do not save the same way, and saying so is the point of
 * splitting them: tools and header overrides are part of the version and land
 * with its Save — the footer button, which is the page's own — while the
 * connection belongs to the project and is written the moment its own buttons
 * are pressed. One "Save" over all three would have to lie about one of them,
 * so the footer names what it commits.
 */

import { Modal } from "@/app/_components/Modal";
import { McpConnectionCard } from "./McpConnectionCard";
import { buttonClass } from "@/app/_components/buttonStyles";

/**
 * The page's own version save, handed down so the two version-owned sections
 * can be committed from here. Without it the dialog covers the only button that
 * would store what it just edited.
 */
export interface VersionSave {
  run: () => void;
  /** True while the write is in flight. */
  saving: boolean;
  /** Blocked for a reason pressing the button cannot fix — no model chosen yet. */
  disabled: boolean;
  /**
   * The page's last save error. Repeated here because the dialog covers where
   * the page reports it, and a Save that fails behind a dialog looks like a
   * Save that did nothing.
   */
  error: string | null;
  /** Version the last save wrote, or null once the draft is edited again. */
  savedName: string | null;
  /** "Save" or "Create version" — the page owns which, so the two agree. */
  label: string;
}

export function McpBindingSettings({
  projectName,
  serverName,
  onClose,
  save,
  tools,
  headers,
}: {
  projectName: string;
  serverName: string;
  onClose: () => void;
  save: VersionSave;
  /** Tool selector for this binding, rendered by the caller that owns the value. */
  tools: React.ReactNode;
  /** Header-override editor for this binding, likewise. */
  headers: React.ReactNode;
}) {
  return (
    <Modal
      title={`${serverName} settings`}
      onClose={onClose}
      footer={
        <>
          {save.error ? (
            <p className="mr-auto text-xs text-red-600 dark:text-red-400">{save.error}</p>
          ) : save.savedName ? (
            <p className="mr-auto text-xs text-emerald-600 dark:text-emerald-400">
              Saved v{save.savedName}
            </p>
          ) : (
            <p className="mr-auto text-xs text-neutral-400">
              Saves the whole version, not just this server.
            </p>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 text-sm text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            Close
          </button>
          <button
            type="button"
            onClick={save.run}
            disabled={save.saving || save.disabled}
            className={buttonClass("primary")}
          >
            {save.saving ? "Saving…" : save.label}
          </button>
        </>
      }
    >
      <Section
        title="Tools"
        note="Which of this server's tools this version offers the model. Saved with the version."
      >
        {tools}
      </Section>
      <Section
        title="Header overrides"
        note="Layered over the registry entry's headers, for this version only. Saved with the version."
      >
        {headers}
      </Section>
      <Section
        title="Connection"
        note="This project's own credentials for the server, shared by all its versions. Saved immediately, not with the version."
      >
        <McpConnectionCard projectName={projectName} serverName={serverName} />
      </Section>
    </Modal>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h3>
        <p className="mt-0.5 text-xs text-neutral-400">{note}</p>
      </div>
      {children}
    </section>
  );
}
