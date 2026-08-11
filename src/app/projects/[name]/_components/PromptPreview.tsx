"use client";

import { useMemo, useState } from "react";
import { findTemplateVariables } from "@/shared/template";
import {
  previewPrompt,
  type ProjectType,
  type PromptPreview,
  type VersionInput,
} from "../../lib/api";
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
  projectType,
  draft,
  versionName,
}: {
  projectName: string;
  projectType: ProjectType;
  draft: VersionInput;
  /**
   * The saved version the draft started from, or null for one never saved. The
   * server resolves masked header overrides against it — without it a bound MCP
   * server is dialled with the wrong headers, and the preview would describe a
   * request no run makes.
   */
  versionName: string | null;
}) {
  const [preview, setPreview] = useState<PromptPreview | null>(null);
  const [previewOf, setPreviewOf] = useState<string>("");
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only the user prompt template is rendered with variables — a {{var}} in
  // the system prompt reaches the model as literal text, and an agent run
  // never sends the template at all — so only a rendered template gets fields.
  const varNames = useMemo(
    () =>
      projectType === "agent" ? [] : [...findTemplateVariables(draft.userPromptTemplate)],
    [projectType, draft.userPromptTemplate],
  );
  // Only discovery reads the request, so the box is offered only where it
  // changes the answer — anywhere else it would suggest the prompt depends on
  // the turn, which for an agent run it does not.
  const usesRequest = draft.parameters.dynamicCapabilities === true;
  const current = JSON.stringify({ draft, variables, message });
  const stale = preview !== null && previewOf !== current;

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const result = await previewPrompt(projectName, {
        ...draft,
        ...(versionName ? { versionName } : {}),
        variables,
        ...(usesRequest && message.trim() ? { message } : {}),
      });
      setPreview(result);
      setPreviewOf(JSON.stringify({ draft, variables, message }));
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

      {usesRequest && (
        <TextInput
          label="Request"
          description="Searched against the registry alongside the system prompt. Leave it empty to see what every run starts with."
          placeholder="e.g. aws eks 최신 버전 알려줘"
          value={message}
          onChange={(e) => setMessage(e.currentTarget.value)}
        />
      )}

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {preview && preview.discovered.length > 0 && (
        // Blue, not yellow: these were *found*, and the prompt above already
        // includes them without saying which rows the version never bound.
        <Alert color="blue" variant="light" fz="xs">
          Found for this request, on top of the bindings: {preview.discovered.join(", ")}
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
