"use client";

import { useEffect, useRef, useState } from "react";
import {
  previewPrompt,
  type PromptPreview,
  type AgentConfigurationInput,
} from "../../lib/api";
import {
  Alert,
  Button,
  Code,
  Group,
  Spoiler,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";
import { useLocale, useT } from "@/app/_i18n/provider";
import { CopyButton } from "@/app/_components/CopyButton";
import { JsonHighlight } from "@/app/_components/JsonHighlight";
import { onModEnter } from "@/app/_lib/modEnter";
import { createLatestOnly } from "@/app/_lib/latestOnly";

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
 * Fetched only on demand: it may recall memory, contact MCP servers for their
 * real tool names, and search the capability catalog. A draft edited after the
 * last fetch is marked stale rather than refetched.
 */
export function PromptPreview({
  projectName,
  draft,
  validationError,
}: {
  projectName: string;
  draft: AgentConfigurationInput;
  validationError: string | null;
  /**
   * The saved version the draft started from, or null for one never saved. The
   * server resolves masked header overrides against it — without it a bound MCP
   * server is dialled with the wrong headers, and the preview would describe a
   * request no run makes.
   */
}) {
  const [preview, setPreview] = useState<PromptPreview | null>(null);
  const [previewOf, setPreviewOf] = useState<string>("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useT();
  const locale = useLocale();
  const latestOnly = useRef(createLatestOnly()).current;
  const previewRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      // Retire the current result before aborting so its finally block cannot
      // write loading state after this panel has unmounted.
      latestOnly();
      previewRequest.current?.abort();
    };
  }, [latestOnly]);

  // Discovery and memory recall both depend on the request. Without either,
  // the box would suggest the assembled prompt varies when it does not.
  const usesRequest =
    (draft.parameters.dynamicCapabilities === true || draft.parameters.memoryRecall === true);
  // The saved version identifies the stored header overrides a masked draft is
  // resolved against. Two versions can render the same fields but decrypt to
  // different credentials, so that identity is part of preview freshness too.
  const current = JSON.stringify({
    projectName,
      draft,
    ...(usesRequest ? { message } : {}),
  });
  const stale = preview !== null && (validationError !== null || previewOf !== current);

  useEffect(() => {
    const active = previewRequest.current;
    if (!active) {
      return;
    }
    // The response would be stale by construction. Stop its MCP and catalog
    // work instead of merely refusing to paint it when it eventually returns.
    latestOnly();
    previewRequest.current = null;
    active.abort();
    setLoading(false);
  }, [current, latestOnly]);

  async function refresh() {
    if (validationError !== null) {
      return;
    }
    previewRequest.current?.abort();
    const controller = new AbortController();
    previewRequest.current = controller;
    const isCurrent = latestOnly();
    const requested = current;
    setLoading(true);
    setError(null);
    try {
      const result = await previewPrompt(
        projectName,
        {
          ...draft,
          ...(usesRequest && message.trim() ? { message } : {}),
        },
        controller.signal,
      );
      if (isCurrent()) {
        setPreview(result);
        setPreviewOf(requested);
      }
    } catch (e) {
      if (!controller.signal.aborted && isCurrent()) {
        setError(e instanceof Error ? e.message : t("preview.failed"));
      }
    } finally {
      if (previewRequest.current === controller) {
        previewRequest.current = null;
      }
      if (isCurrent()) {
        setLoading(false);
      }
    }
  }

  return (
    <Stack
      gap="sm"
      onKeyDown={onModEnter(() => {
        if (draft.model && !loading) {
          void refresh();
        }
      })}
    >
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Group gap={6} fz="xs" c="dimmed">
          {preview && (
            <>
              <Text fz="xs" c="dimmed">
                {t("preview.chars", { count: charCount(preview).toLocaleString(locale) })}
              </Text>
              {preview.toolNames.length > 0 && (
                <Text fz="xs" c="dimmed">
                  {t("preview.tools", { count: preview.toolNames.length })}
                </Text>
              )}
            </>
          )}
          {stale && (
            <Text fz="xs" c="orange">
              {t("preview.stale")}
            </Text>
          )}
        </Group>
        <Group gap="xs" wrap="nowrap">
          {preview && <CopyButton text={promptText(preview)} />}
          <Button
            size="compact-sm"
            onClick={() => void refresh()}
            loading={loading}
            disabled={!draft.model || validationError !== null}
          >
            {preview ? t("preview.refresh") : t("preview.build")}
          </Button>
        </Group>
      </Group>

      {usesRequest && (
        <Textarea
          label={t("preview.request")}
          description={t("preview.requestHint")}
          placeholder={t("preview.requestPlaceholder")}
          value={message}
          onChange={(e) => setMessage(e.currentTarget.value)}
          maxLength={8000}
          autosize
          minRows={2}
          maxRows={8}
        />
      )}

      {(validationError || error) && (
        <Alert color="red" variant="light">
          {validationError || error}
        </Alert>
      )}

      {preview && preview.discovered.length > 0 && (
        // Blue, not yellow: these were *found*, and the prompt above already
        // includes them without saying which rows the version never bound.
        <Alert color="blue" variant="light" fz="xs">
          {t("preview.discovered", { names: preview.discovered.join(", ") })}
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
          {t("preview.noPrompt")}
        </Text>
      )}

      {preview && preview.toolNames.length > 0 && (
        <Spoiler
          maxHeight={0}
          showLabel={t("preview.toolsOffered", { count: preview.toolNames.length })}
          hideLabel={t("preview.hideTools")}
          fz="xs"
        >
          <Code block fz="xs" mt={4} mah={384} style={{ overflow: "auto" }}>
            <JsonHighlight text={JSON.stringify(preview.tools, null, 2)} />
          </Code>
        </Spoiler>
      )}

      {!preview && !error && (
        <Text fz="xs" c="dimmed">
          {t("preview.blurb")}
        </Text>
      )}
    </Stack>
  );
}
