"use client";

/**
 * Everything configurable about one bound MCP server, in one place.
 *
 * The three sections do not save the same way, and saying so is the point of
 * splitting them: tools and header overrides are part of the version and land
 * with its Save, while the connection belongs to the project and is written the
 * moment its own buttons are pressed. A single "Save" over all three would have
 * to lie about one of them.
 */

import { Modal } from "@/app/_components/Modal";
import { McpConnectionCard } from "./McpConnectionCard";

export function McpBindingSettings({
  projectName,
  serverName,
  onClose,
  tools,
  headers,
}: {
  projectName: string;
  serverName: string;
  onClose: () => void;
  /** Tool selector for this binding, rendered by the caller that owns the value. */
  tools: React.ReactNode;
  /** Header-override editor for this binding, likewise. */
  headers: React.ReactNode;
}) {
  return (
    <Modal title={`${serverName} settings`} onClose={onClose}>
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
