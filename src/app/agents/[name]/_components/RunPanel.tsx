"use client";

import { canRunAgents, useViewer } from "@/app/_lib/useViewer";
import type { EvaluationReceipt } from "@/domain/evaluation/types";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { EvaluationPanel } from "./EvaluationPanel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EngineChunk } from "../../lib/api";
import { readSse, streamAgent } from "../../lib/api";
import { parseWireToolCall } from "@/app/_lib/toolCalls";
import { pairToolTraffic } from "@/app/_lib/toolPairs";
import { formatUsd } from "@/app/_lib/formatUsd";
import { useImageViewer } from "@/app/_components/ImageViewer";
import { ProducedFile } from "@/app/_components/ProducedFile";
import { MarkdownContent } from "@/app/_components/MarkdownContent";
import { createTextPacer } from "@/app/_lib/textPacer";
import { ReasoningRow } from "@/app/_components/ReasoningRow";
import { ToolRow } from "@/app/_components/ToolRow";
import {
  chunkAuthorPath,
  mergeVisitedPath,
  activeAuthorPaths,
  foldActiveAuthors,
  type ActiveAuthor,
} from "@/app/_lib/authorPaths";
import { toRequestImages } from "@/app/_lib/imageAttachments";
import { createFileDownloads } from "@/app/_lib/fileDownloads";
import { onModEnter } from "@/app/_lib/modEnter";
import {
  AttachButton,
  AttachmentBar,
  DropHint,
  onFilePaste,
  useAttachments,
  useFileDrop,
} from "@/app/_components/ImageAttachments";
import { useT } from "@/app/_i18n/provider";
import { collectedWarning, imageDataUrl, isTopLevelChunk } from "@/domain/llm/types";
import {
  Alert,
  Badge,
  Button,
  Group,
  Image,
  Input,
  Paper,
  Stack,
  Text,
  Textarea,
  UnstyledButton,
} from "@mantine/core";
import { BADGE, SUBAGENT_COLOR } from "@/app/_components/badgeColors";

interface ToolResultView {
  /** The call this answers — what pairs a result back to the row it belongs on. */
  id?: string | undefined;
  name: string;
  content: string;
  author?: string | undefined;
  authorPath?: string[] | undefined;
  transferId?: string | undefined;
}
interface ToolCallView {
  id?: string | undefined;
  name: string;
  args: string;
  author?: string | undefined;
  authorPath?: string[] | undefined;
  transferId?: string | undefined;
}

function toolCallView(raw: unknown, chunk: EngineChunk): ToolCallView {
  return { ...parseWireToolCall(raw), author: chunk.author, authorPath: chunk.authorPath, transferId: chunk.transferId };
}

type RunPanelInput = Pick<ReturnType<typeof useAttachments>, "attachments" | "documents"> & {
  message: string;
  configurationUpdatedAt: string;
};

export function RunPanel({
  agentName,
  configured,
  modelAcceptsImages,
  configurationUpdatedAt,
  unsaved,
}: {
  agentName: string;
  configured: boolean;
  configurationUpdatedAt: string;
  unsaved: boolean;
  /** From the model registry; `undefined` when the model is not in the catalog. */
  modelAcceptsImages?: boolean;
}) {
  const mayRun = canRunAgents(useViewer());
  const [message, setMessage] = useState("");

  const [running, setRunning] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [lastAttempt, setLastAttempt] = useState<RunPanelInput | null>(null);
  const [lastReceipt, setLastReceipt] = useState<{ input: RunPanelInput; receipt: EvaluationReceipt } | null>(null);
  const [text, setText] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [reasoningTokens, setReasoningTokens] = useState(0);
  /** When this run started — the identity of the panels it owns. */
  const [startedAt, setStartedAt] = useState(0);
  const [toolCalls, setToolCalls] = useState<ToolCallView[]>([]);
  const [toolResults, setToolResults] = useState<ToolResultView[]>([]);
  const [activeAuthors, setActiveAuthors] = useState<ActiveAuthor[]>([]);
  const activePaths = useMemo(() => activeAuthorPaths(activeAuthors), [activeAuthors]);
  const [visitedPaths, setVisitedPaths] = useState<string[][]>([]);
  const [error, setError] = useState<string | null>(null);
  // Run losses and limits reported alongside the answer.
  const [warnings, setWarnings] = useState<string[]>([]);
  const [cost, setCost] = useState<number | null>(null);
  const [agentImages, setAgentImages] = useState<Array<{ src: string; prompt?: string }>>([]);
  // Stored files arrive addressed; without storage the stream delivers inline bytes.
  const [agentFiles, setAgentFiles] = useState<
    Array<{ name: string; mimeType: string; byteSize?: number; url?: string; artifactId?: string }>
  >([]);
  const activeRequest = useRef<AbortController | null>(null);
  const {
    attachments,
    documents,
    attachError,
    reading,
    addFiles,
    removeAt,
    removeDocumentAt,
  } = useAttachments({ documents: true });
  const t = useT();
  const view = useImageViewer();
  // Compare references instead of repeatedly serializing attachment bytes on every chunk.
  const editedInput = useMemo(() => ({ message, attachments, documents, configurationUpdatedAt }),
    [message, attachments, documents, configurationUpdatedAt]);
  const inputKey = [lastReceipt?.input, lastAttempt].find(input => input && input.message === message &&
    input.attachments === attachments && input.documents === documents && input.configurationUpdatedAt === configurationUpdatedAt) ?? editedInput;
  const receipt = lastReceipt?.input === inputKey ? lastReceipt.receipt : null;

  // An image-only turn is a legitimate run: "what is in this picture?" needs no words.
  const canRun =
    mayRun && configured &&
    !running && !evaluating &&
    !reading &&
    (message.trim() !== "" || attachments.length > 0 || documents.length > 0);
  const attachHint = t("run.attachHintLook");

  useEffect(
    () => () => {
      activeRequest.current?.abort();
      activeRequest.current = null;
    },
    [],
  );

  async function run(): Promise<EvaluationReceipt | null> {
    if (!canRun) return null;
    if (!configured || activeRequest.current !== null) {
      return null;
    }
    const controller = new AbortController();
    activeRequest.current = controller;
    const isCurrent = () => activeRequest.current === controller;
    setRunning(true);
    setLastAttempt(inputKey);
    setLastReceipt(null);
    // Reasoning arrives token by token and can run far longer than the answer,
    // so it is committed in batches rather than per token — the same rule the
    // chat thread's store applies to what it draws.
    const reasoningPacer = createTextPacer((batch) => {
      if (isCurrent()) {
        setReasoning((prev) => prev + batch);
      }
    });
    const answerPacer = createTextPacer((batch) => {
      if (isCurrent()) {
        setText((prev) => prev + batch);
      }
    });
    setText("");
    setReasoning("");
    setReasoningTokens(0);
    setStartedAt(Date.now());
    setToolCalls([]);
    setToolResults([]);
    setActiveAuthors([]);
    setVisitedPaths([]);
    setError(null);
    setWarnings([]);
    setCost(null);
    setAgentImages([]);
    setAgentFiles([]);
    const fileDownload = createFileDownloads();
    let totalCost = 0;
    let runReceipt: EvaluationReceipt | null = null;

    try {

      const imageParts = toRequestImages(attachments).map((image) => ({
        type: "image_url" as const,
        image_url: { url: imageDataUrl(image) },
      }));
      const res = await streamAgent(
        agentName,
        [{
          role: "user",
          content: imageParts.length > 0
            ? [...(message ? [{ type: "text" as const, text: message }] : []), ...imageParts]
            : message,
        }],
        controller.signal,
        documents,
        { captureEvaluation: true, expectedUpdatedAt: configurationUpdatedAt },
      );

      for await (const chunk of readSse(res) as AsyncGenerator<EngineChunk>) {
        if (!isCurrent()) {
          break;
        }
        if (chunk.evaluation) {
          runReceipt = chunk.evaluation;
          setLastReceipt({ input: inputKey, receipt: runReceipt });
        }
        if (chunk.error) {
          // A subagent failure is reported to the parent as a tool error and the
          // parent may still answer; only a top-level error is the run's — an
          // authored one in the banner reported a finished run as failed.
          if (isTopLevelChunk(chunk)) {
            setError(chunk.error);
            continue;
          }
          continue;
        }
        setWarnings((prev) => {
          const reported = collectedWarning(chunk, prev);
          return reported === undefined ? prev : [...prev, reported];
        });
        const path = chunkAuthorPath(chunk);
        setActiveAuthors(prev => foldActiveAuthors(prev, chunk));
        if (path && !chunk.authorDone) {
          setVisitedPaths((prev) => mergeVisitedPath(prev, path));
        }
        const content = chunk.delta?.content;
        if (content && isTopLevelChunk(chunk)) {
          answerPacer.push(content);
        }
        // Only an Agent with `reasoningTrace` on produces any; top-level for
        // the reason the answer is — a child's thinking is its own run's.
        const reasoned = chunk.delta?.reasoningContent;
        if (reasoned && isTopLevelChunk(chunk)) {
          reasoningPacer.push(reasoned);
        }
        if (chunk.delta?.toolCalls) {
          const calls = chunk.delta.toolCalls.map((c) => toolCallView(c, chunk));
          setToolCalls((prev) => [...prev, ...calls]);
        }
        if (chunk.toolResult) {
          const result: ToolResultView = {
            id: chunk.toolResult.toolCallId,
            name: chunk.toolResult.name,
            content: chunk.toolResult.content,
            author: chunk.author,
            authorPath: chunk.authorPath,
            transferId: chunk.transferId,
          };
          setToolResults((prev) => [...prev, result]);
        }
        if (chunk.image) {
          const generated = chunk.image;
          setAgentImages((prev) => [...prev, { src: imageDataUrl(generated),
            ...(generated.prompt ? { prompt: generated.prompt } : {}) }]);
        }
        if (chunk.file) {
          const produced = chunk.file;
          const download = fileDownload(produced);
          if (download.warning) {
            const warning = download.warning;
            setWarnings((prev) => prev.includes(warning) ? prev : [...prev, warning]);
          }
          if (!download.warning && (download.url || produced.fileId)) setAgentFiles((prev) => [
            ...prev,
            {
              name: produced.name,
              mimeType: produced.mimeType,
              ...(produced.byteSize !== undefined ? { byteSize: produced.byteSize } : {}),
              ...(download.url ? { url: download.url } : {}),
              ...(produced.fileId ? { artifactId: produced.fileId } : {}),
            },
          ]);
        }
        if (chunk.usage) {
          totalCost += chunk.usage.costUsd;
          setCost(totalCost);
          const thought = chunk.usage.reasoningTokens;
          if (thought !== undefined && isTopLevelChunk(chunk)) {
            setReasoningTokens((prev) => prev + thought);
          }
        }
      }
    } catch (e) {
      if (isCurrent()) {
        const message = e instanceof Error ? e.message : t("run.failed");
        setError(previous => previous ?? message);
      }
    } finally {
      // Whatever the last batch was holding, on every exit path: a run that
      // ends mid-interval would otherwise leave its last answer or thought unshown.
      answerPacer.flush();
      reasoningPacer.flush();
      if (isCurrent()) {
        activeRequest.current = null;
        setActiveAuthors([]);
        setRunning(false);
      }
    }
    return runReceipt;
  }

  async function ensureRun(): Promise<EvaluationReceipt> {
    if (receipt) return receipt;
    // Missing evidence after an attempted run is uncertain; evaluation must not replay tools.
    if (lastAttempt === inputKey) throw new Error(t("evaluation.missingEvidence"));
    const captured = await run();
    if (!captured) throw new Error(t("evaluation.missingEvidence"));
    return captured;
  }

  // Pasted and dropped images become inputs for image understanding or EditImage.
  const attach = useCallback((files: File[]) => void addFiles(files), [addFiles]);
  const { dragging, handlers } = useFileDrop(attach, running || evaluating || !mayRun);
  const onPaste = useMemo(() => onFilePaste(attach, running || evaluating || !mayRun), [attach, running, evaluating, mayRun]);

  return (
    <>
    <CollapsibleSection title={t("playground.run")} defaultOpen>
    <Stack
      gap="md"
      onKeyDown={onModEnter(() => {
        if (canRun) {
          void run();
        }
      })}
      {...handlers}
      style={{ position: "relative" }}
    >
      {dragging && <DropHint />}
      {!configured && <Alert color="yellow" variant="light" fz="xs">{t("configuration.saveToRun")}</Alert>}

      <Textarea
        label={t("run.messageLabel")}
        readOnly={!mayRun || running || evaluating}
        value={message}
        onChange={(e) => setMessage(e.currentTarget.value)}
        onPaste={onPaste}
        autosize
        minRows={4}
        maxRows={16}
        placeholder={t("run.askPlaceholder")}
      />

      <Input.Wrapper
        label={t("run.images")}
        labelElement="div"
        description={attachHint}
        inputWrapperOrder={["label", "description", "input"]}
      >
        <Stack gap={4} mt={4}>
          <AttachmentBar
            attachments={attachments}
            documents={documents}
            attachError={attachError}
            onRemove={running || evaluating ? undefined : removeAt}
            onRemoveDocument={running || evaluating ? undefined : removeDocumentAt}
          />
          <Group>
            <AttachButton
              onPick={attach}
              disabled={running || evaluating || !mayRun}
              documents
            />
          </Group>
          {modelAcceptsImages === false && attachments.length > 0 && (
            <Text fz="xs" c="red">
              {t("run.noImageInput")}
            </Text>
          )}
        </Stack>
      </Input.Wrapper>

      <Group>
        {!mayRun && <Text size="sm" c="dimmed">{t("common.memberExecutionRequired")}</Text>}
        <Button onClick={run} loading={running || reading} disabled={!canRun}>
          {t("playground.run")}
        </Button>
      </Group>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {warnings.length > 0 && (
        <Alert color="yellow" variant="light">
          <Stack gap={4}>
            {warnings.map((warning) => (
              <Text key={warning} fz="sm">
                {warning}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}

      {(activePaths.length > 0 || visitedPaths.length > 0) && (
        <Stack gap={4}>
          <Group gap={6} wrap="wrap">
            <Text fz="xs" c="dimmed">
              {running ? t("run.running") : t("run.ran")}
            </Text>
            <Badge color={BADGE.owned} ff="monospace">
              {agentName}
            </Badge>
            {activePaths.length > 0 && (
              <Text fz="xs" c="dimmed">
                →
              </Text>
            )}
            {/* One badge per chain, side by side — several children of one
                dispatch are running at the same time, not in sequence. */}
            {activePaths.map((path) => (
              <Badge key={path.join(">")} color={SUBAGENT_COLOR} ff="monospace">
                {path.join(" → ")}
              </Badge>
            ))}
          </Group>
          {visitedPaths.length > 0 && (
            <Text fz="xs" c="dimmed">
              {t("run.agentsInvolved", {
                agents: visitedPaths.map((path) => path.join(" → ")).join(", "),
              })}
            </Text>
          )}
        </Stack>
      )}

      {/* Ahead of the answer, where it happened. Open while the model is still
          thinking and has said nothing, so a long silence shows what fills it. */}
      <ReasoningRow
        // Same identity the chat uses: the run's own start, stable
        // for its whole life. A new one per Run, so collapsing the panel once
        // does not switch off the auto-open for every later run; and nothing
        // that changes at the finish, which would shut it as the answer lands.
        key={`reasoning-${startedAt}`}
        text={reasoning}
        {...(reasoningTokens > 0 ? { tokens: reasoningTokens } : {})}
        streaming={running && text === "" && reasoning !== ""}
      />

      <Paper withBorder p="sm" mih={96}>
        {text ? <MarkdownContent content={text} /> : (
          <Text fz="sm" c="dimmed">
            {t("run.outputWillStream")}
          </Text>
        )}
      </Paper>

      {agentImages.map((img, i) => (
        <UnstyledButton
          type="button"
          key={`image-${i}`}
          aria-label={t("chat.generatedImage")}
          w="100%"
          onClick={() =>
            view({
              src: img.src,
              alt: img.prompt ?? t("chat.generatedImage"),
              title: t("chat.generatedImage"),
              ...(img.prompt ? { caption: img.prompt } : {}),
            })
          }
          style={{ cursor: "zoom-in" }}
        >
          <Image
            src={img.src}
            alt={img.prompt ?? t("chat.generatedImage")}
            radius="md"
          />
        </UnstyledButton>
      ))}

      {/* The same row the chat draws. A rendered document is part of the answer,
          not an invisible side effect beside the image gallery. */}
      {agentFiles.map((file, i) => (
        <ProducedFile key={`file-${i}`} {...file} />
      ))}

      {/* Share Chat's paired tool rows: one row per call, with its result. */}
      {(toolCalls.length > 0 || toolResults.length > 0) && (
        <Stack gap={0}>
          {pairToolTraffic(toolCalls, toolResults).map((pair, i) => (
            <ToolRow key={`tool-${i}`} pair={pair} />
          ))}
        </Stack>
      )}

      {cost !== null && (
        <Text fz="xs" c="dimmed">
          est. cost: {formatUsd(cost, 6)}
        </Text>
      )}
    </Stack>
    </CollapsibleSection>
    <CollapsibleSection title={t("evaluation.title")} keepActive>
      <EvaluationPanel agentName={agentName} inputKey={inputKey} receipt={receipt}
        canEvaluate={canRun && !unsaved} running={running} unsaved={unsaved}
        ensureRun={ensureRun} onBusyChange={setEvaluating} />
    </CollapsibleSection>
    </>
  );
}
