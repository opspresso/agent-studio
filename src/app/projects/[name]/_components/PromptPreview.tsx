"use client";

import { useMemo, useState } from "react";
import { findTemplateVariables } from "@/application/llm/template";
import { previewPrompt, type PromptPreview, type VersionInput } from "../../lib/api";
import {
  Alert,
  Button,
  Code,
  Group,
  Input,
  Spoiler,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { CopyButton } from "@/app/_components/CopyButton";

/** The whole assembled prompt as one block, for pasting elsewhere. */
function promptText(preview: PromptPreview): string {
  const messages = preview.messages
    .map((message) => `[${message.role}]\n${message.content}`)
    .join("\n\n");
  const tools =
    preview.tools.length > 0 ? `[tools]\n${JSON.stringify(preview.tools, null, 2)}` : "";
  return [messages, tools].filter(Boolean).join("\n\n");
}

function charCount(preview: PromptPreview): number {
  return preview.messages.reduce((total, message) => total + message.content.length, 0);
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
    <Stack gap="sm">
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Group gap={6} fz="xs" c="dimmed">
          {preview && (
            <>
              <Text fz="xs" c="dimmed">
                {charCount(preview).toLocaleString()} chars
              </Text>
              {preview.toolNames.length > 0 && (
                <Text fz="xs" c="dimmed">
                  · {preview.toolNames.length} tools
                </Text>
              )}
            </>
          )}
          {stale && (
            <Text fz="xs" c="orange">
              · stale
            </Text>
          )}
        </Group>
        <Group gap="xs" wrap="nowrap">
          {preview && <CopyButton text={promptText(preview)} />}
          <Button
            size="compact-sm"
            onClick={() => void refresh()}
            loading={loading}
            disabled={!draft.model}
          >
            {preview ? "Refresh" : "Build preview"}
          </Button>
        </Group>
      </Group>

      {varNames.length > 0 && (
        <Input.Wrapper label="Variables" labelElement="div">
          <Stack gap="xs" mt={4}>
            {varNames.map((name) => (
              <TextInput
                key={name}
                value={variables[name] ?? ""}
                onChange={(e) => {
                  // Captured here: React nulls `currentTarget` when the handler
                  // returns, and the updater below runs on the next render.
                  const value = e.currentTarget.value;
                  setVariables((prev) => ({ ...prev, [name]: value }));
                }}
                leftSectionWidth={132}
                leftSectionPointerEvents="none"
                leftSection={
                  <Text fz="xs" ff="monospace" c="dimmed" truncate px="xs">
                    {name}
                  </Text>
                }
              />
            ))}
          </Stack>
        </Input.Wrapper>
      )}

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {preview?.warnings.map((warning, index) => (
        <Alert key={`warning-${index}`} color="yellow" variant="light" fz="xs">
          {warning}
        </Alert>
      ))}

      {preview?.messages.map((message, index) => (
        <Stack key={`message-${index}`} gap={4}>
          <Text
            ff="monospace"
            fz="xs"
            tt="uppercase"
            c="dimmed"
            style={{ letterSpacing: "0.05em" }}
          >
            {message.role}
          </Text>
          <Code block fz="xs" mah={384} style={{ overflow: "auto", whiteSpace: "pre-wrap" }}>
            {message.content}
          </Code>
        </Stack>
      ))}

      {preview && preview.messages.length === 0 && (
        <Text fz="xs" c="dimmed">
          This version sends no prompt of its own; the conversation supplies everything.
        </Text>
      )}

      {preview && preview.toolNames.length > 0 && (
        <Spoiler
          maxHeight={0}
          showLabel={`Tools offered (${preview.toolNames.length})`}
          hideLabel="Hide tools"
          fz="xs"
        >
          <Code block fz="xs" mt={4} mah={384} style={{ overflow: "auto" }}>
            {JSON.stringify(preview.tools, null, 2)}
          </Code>
        </Spoiler>
      )}

      {!preview && !error && (
        <Text fz="xs" c="dimmed">
          Builds the system prompt the way a run does — skill table, connected MCP servers and
          their tool names, transfer instructions — by contacting the bound MCP servers.
        </Text>
      )}
    </Stack>
  );
}
