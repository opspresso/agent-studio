"use client";

/**
 * Everything configurable about one bound MCP server, in one place.
 *
 * Tools, header overrides and source mappings save with Agent configuration
 * through the footer. OAuth connection actions save independently when pressed.
 */

import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { McpConnectionCard } from "./McpConnectionCard";
import { ConfigurationFields } from "./ConfigurationFields";

/**
 * The page's own configuration save, handed down so the two configuration sections
 * can be committed from here. Without it the dialog covers the only button that
 * would store what it just edited.
 */
export interface ConfigurationSave {
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
  /** True after a successful save while the draft remains unchanged. */
  saved: boolean;
  /** Localized save label supplied by the owning page. */
  label: string;
}

export function McpBindingSettings({
  agentName,
  canEdit,
  mayConnect,
  serverName,
  onClose,
  save,
  tools,
  headers,
  sources,
  onConnectionChanged,
}: {
  agentName: string;
  canEdit: boolean;
  mayConnect: boolean;
  serverName: string;
  onClose: () => void;
  save: ConfigurationSave;
  /**
   * Forwarded to the connection card. The tool list above it is what a changed
   * connection invalidates, and the caller owns that list — this dialog only
   * puts the two in the same place.
   */
  onConnectionChanged?: () => void;
  /** Tool selector for this binding, rendered by the caller that owns the value. */
  tools: React.ReactNode;
  /** Header-override editor for this binding, likewise. */
  headers: React.ReactNode;
  sources?: React.ReactNode;
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
        <Section title={t("mcpSettings.connection")} note={t("mcpSettings.connectionNote")}>
          {mayConnect ? <McpConnectionCard
            agentName={agentName}
            serverName={serverName}
            onConnectionChanged={onConnectionChanged}
          /> : <Text fz="sm" c="dimmed">{t("common.memberExecutionRequired")}</Text>}
        </Section>
        <Section title={t("mcpSettings.tools")} note={t("mcpSettings.toolsNote")}>
          {tools}
        </Section>
        <ConfigurationFields disabled={!canEdit || save.saving} gap="lg">
          <Section title={t("mcpSettings.overrides")} note={t("mcpSettings.overridesNote")}>
            {headers}
          </Section>
          {sources && <Stack gap="xs"><Text fw={600}>{t("audio.mappingTitle")}</Text>{sources}</Stack>}
        </ConfigurationFields>


        <Group
          justify="flex-end"
          gap="sm"
          pt="sm"
          style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
        >
          {!canEdit ? (
            <Text fz="xs" c="dimmed" mr="auto">{t("playground.readOnly")}</Text>
          ) : save.error ? (
            <Text fz="xs" c="red" mr="auto">
              {save.error}
            </Text>
          ) : save.saved ? (
            <Text fz="xs" c="teal" mr="auto">
              {t("configuration.saved")}
            </Text>
          ) : (
            <Text fz="xs" c="dimmed" mr="auto">
              {t("mcpSettings.savesConfiguration")}
            </Text>
          )}
          <Button variant="subtle" color="gray" onClick={onClose}>
            {t("mcpSettings.close")}
          </Button>
          {canEdit && <Button onClick={save.run} loading={save.saving} disabled={save.disabled}>
            {save.label}
          </Button>}
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
