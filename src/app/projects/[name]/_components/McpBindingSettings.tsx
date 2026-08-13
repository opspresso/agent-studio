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

import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { McpConnectionCard } from "./McpConnectionCard";

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
  const t = useT();
  return (
    <Modal
      opened
      onClose={onClose}
      title={t("mcpSettings.title", { server: serverName })}
      size="xl"
      // A form that vanished because the pointer drifted over the edge would
      // lose whatever was typed.
      closeOnClickOutside={false}
    >
      <Stack gap="lg">
        <Section title={t("mcpSettings.tools")} note={t("mcpSettings.toolsNote")}>
          {tools}
        </Section>
        <Section title={t("mcpSettings.overrides")} note={t("mcpSettings.overridesNote")}>
          {headers}
        </Section>
        <Section title={t("mcpSettings.connection")} note={t("mcpSettings.connectionNote")}>
          <McpConnectionCard projectName={projectName} serverName={serverName} />
        </Section>

        <Group
          justify="flex-end"
          gap="sm"
          pt="sm"
          style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
        >
          {save.error ? (
            <Text fz="xs" c="red" mr="auto">
              {save.error}
            </Text>
          ) : save.savedName ? (
            <Text fz="xs" c="teal" mr="auto">
              {t("playground.saved", { version: save.savedName })}
            </Text>
          ) : (
            <Text fz="xs" c="dimmed" mr="auto">
              {t("mcpSettings.savesWholeVersion")}
            </Text>
          )}
          <Button variant="subtle" color="gray" onClick={onClose}>
            {t("mcpSettings.close")}
          </Button>
          <Button onClick={save.run} loading={save.saving} disabled={save.disabled}>
            {save.label}
          </Button>
        </Group>
      </Stack>
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
    <Stack component="section" gap="xs">
      <div>
        <Text
          component="h3"
          fz="xs"
          fw={600}
          tt="uppercase"
          c="dimmed"
          style={{ letterSpacing: "0.05em" }}
        >
          {title}
        </Text>
        <Text fz="xs" c="dimmed" mt={2}>
          {note}
        </Text>
      </div>
      {children}
    </Stack>
  );
}
