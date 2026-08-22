"use client";

import { useCallback, useMemo, useState } from "react";
import type { EngineChunk, ImageResult, ProjectType } from "../../lib/api";
import { predictImage, readSse, streamAgent, streamPredict } from "../../lib/api";
import { parseWireToolCall } from "@/app/_lib/toolCalls";
import { findTemplateVariables } from "@/shared/template";
import { pairToolTraffic } from "@/app/_lib/toolPairs";
import { formatUsd } from "@/app/_lib/formatUsd";
import { useImageViewer } from "@/app/_components/ImageViewer";
import { ProducedFile } from "@/app/_components/ProducedFile";
import { createTextPacer } from "@/app/_lib/textPacer";
import { ReasoningRow } from "@/app/_components/ReasoningRow";
import { ToolRow } from "@/app/_components/ToolRow";
import {
  chunkAuthorPath,
  mergeVisitedPath,
  removeActivePath,
  trackActivePath,
} from "@/app/_lib/authorPaths";
import { toRequestImages } from "@/app/_lib/imageAttachments";
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
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { BADGE, SUBAGENT_COLOR } from "@/app/_components/badgeColors";

interface ToolResultView {
  /** The call this answers — what pairs a result back to the row it belongs on. */
  id?: string | undefined;
  name: string;
  content: string;
  author?: string | undefined;
}
interface ToolCallView {
  id?: string | undefined;
  name: string;
  args: string;
  author?: string | undefined;
}

function toolCallView(raw: unknown, author?: string): ToolCallView {
  return { ...parseWireToolCall(raw), author };
}

export function RunPanel({
  projectName,
  versionName,
  projectType,
  userPromptTemplate,
  modelAcceptsImages,
}: {
  projectName: string;
  versionName: string | null;
  projectType: ProjectType;
  userPromptTemplate: string;
  /** From the model registry; `undefined` when the model is not in the catalog. */
  modelAcceptsImages?: boolean;
}) {
  // Only the user prompt template is rendered with variables — a {{var}} in
  // the system prompt reaches the model as literal text, so it gets no field.
  const varNames = useMemo(
    () => [...findTemplateVariables(userPromptTemplate)],
    [userPromptTemplate],
  );
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");

  const [running, setRunning] = useState(false);
  const [text, setText] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [reasoningTokens, setReasoningTokens] = useState(0);
  /** When this run started — the identity of the panels it owns. */
  const [startedAt, setStartedAt] = useState(0);
  const [toolCalls, setToolCalls] = useState<ToolCallView[]>([]);
  const [toolResults, setToolResults] = useState<ToolResultView[]>([]);
  // The chain currently producing chunks (outermost first), or undefined while the
  // top-level agent itself is answering.
  // A set, not one chain: `dispatch_agents` has several children running at once.
  const [activePaths, setActivePaths] = useState<string[][]>([]);
  const [visitedPaths, setVisitedPaths] = useState<string[][]>([]);
  const [error, setError] = useState<string | null>(null);
  // What the run reported alongside its answer — an unusable binding, a turn
  // or budget limit. The other surfaces already show these; the playground was
  // the one that stayed silent.
  const [warnings, setWarnings] = useState<string[]>([]);
  const [cost, setCost] = useState<number | null>(null);
  const [image, setImage] = useState<ImageResult | null>(null);
  const [agentImages, setAgentImages] = useState<
    Array<{ b64: string; mimeType: string; prompt?: string }>
  >([]);
  // Documents a tool rendered. They arrive addressed — `/agent` signs the
  // reference on its way out — so what this holds is already a download.
  const [agentFiles, setAgentFiles] = useState<
    Array<{ name: string; byteSize?: number; url?: string }>
  >([]);
  const [size, setSize] = useState("1024x1024");
  const [quality, setQuality] = useState("medium");
  const { attachments, attachError, addFiles, removeAt } = useAttachments();
  const t = useT();
  const view = useImageViewer();

  const needsMessage = projectType === "agent" || projectType === "image";
  // An image-only turn is a legitimate run: "what is in this picture?" needs no words.
  const canRun =
    versionName !== null &&
    !running &&
    (!needsMessage || message.trim() !== "" || attachments.length > 0);
  const attachHint =
    projectType === "image"
      ? attachments.length > 0
        ? t("run.attachHintEdits")
        : t("run.attachHintGenerate")
      : t("run.attachHintLook");

  async function run() {
    if (versionName === null) {
      return;
    }
    setRunning(true);
    // Reasoning arrives token by token and can run far longer than the answer,
    // so it is committed in batches rather than per token — the same rule the
    // chat thread's store applies to what it draws.
    const reasoningPacer = createTextPacer((batch) => setReasoning((prev) => prev + batch));
    setText("");
    setReasoning("");
    setReasoningTokens(0);
    setStartedAt(Date.now());
    setToolCalls([]);
    setToolResults([]);
    setActivePaths([]);
    setVisitedPaths([]);
    setError(null);
    setWarnings([]);
    setCost(null);
    setImage(null);
    setAgentImages([]);
    setAgentFiles([]);
    let totalCost = 0;

    try {
      if (projectType === "image") {
        const result = await predictImage(projectName, versionName, {
          prompt: message,
          size,
          quality,
          images: toRequestImages(attachments),
        });
        setImage(result);
        setCost(result.usage.costUsd);
        // A picture that was drawn and not kept is a loss like any other, and
        // this panel is the one surface that had nowhere to put it: the
        // streaming paths yield it as a `warning` chunk.
        if (result.warning) {
          setWarnings([result.warning]);
        }
        return;
      }
      const imageParts = toRequestImages(attachments).map((image) => ({
        type: "image_url" as const,
        image_url: { url: imageDataUrl(image) },
      }));
      const res =
        projectType === "agent"
          ? await streamAgent(projectName, versionName, [
              {
                role: "user",
                content:
                  imageParts.length > 0
                    ? [...(message ? [{ type: "text" as const, text: message }] : []), ...imageParts]
                    : message,
              },
            ])
          : await streamPredict(projectName, versionName, {
              variables,
              // The prompt itself comes from the template; an attachment rides
              // along as an extra user turn for the model to look at.
              ...(imageParts.length > 0
                ? { messages: [{ role: "user", content: imageParts }] }
                : {}),
            });

      for await (const chunk of readSse(res) as AsyncGenerator<EngineChunk>) {
        if (chunk.error) {
          // A subagent failure is reported to the parent as a tool error and the
          // parent may still answer; only a top-level error is the run's — an
          // authored one in the banner reported a finished run as failed.
          if (isTopLevelChunk(chunk)) {
            setError(chunk.error);
            break;
          }
          continue;
        }
        setWarnings((prev) => {
          const reported = collectedWarning(chunk, prev);
          return reported === undefined ? prev : [...prev, reported];
        });
        // Track who is running: an authored chunk names a chain that is running
        // now and joins the set; an unauthored one means control is back at the
        // top level and none of them is still going.
        const path = chunkAuthorPath(chunk);
        // Two different questions: what is running now, and what this run reached.
        setActivePaths((prev) =>
          path && chunk.authorDone
            ? removeActivePath(prev, path)
            : path
              ? trackActivePath(prev, path)
              : [],
        );
        if (path && !chunk.authorDone) {
          setVisitedPaths((prev) => mergeVisitedPath(prev, path));
        }
        const content = chunk.delta?.content;
        if (content && isTopLevelChunk(chunk)) {
          setText((prev) => prev + content);
        }
        // Only a version with `reasoningTrace` on produces any; top-level for
        // the reason the answer is — a child's thinking is its own run's.
        const reasoned = chunk.delta?.reasoningContent;
        if (reasoned && isTopLevelChunk(chunk)) {
          reasoningPacer.push(reasoned);
        }
        if (chunk.delta?.toolCalls) {
          const calls = chunk.delta.toolCalls.map((c) => toolCallView(c, chunk.author));
          setToolCalls((prev) => [...prev, ...calls]);
        }
        if (chunk.toolResult) {
          const result: ToolResultView = {
            id: chunk.toolResult.toolCallId,
            name: chunk.toolResult.name,
            content: chunk.toolResult.content,
            author: chunk.author,
          };
          setToolResults((prev) => [...prev, result]);
        }
        if (chunk.image) {
          const generated = chunk.image;
          setAgentImages((prev) => [...prev, generated]);
        }
        if (chunk.file) {
          const produced = chunk.file;
          setAgentFiles((prev) => [
            ...prev,
            {
              name: produced.name,
              ...(produced.byteSize !== undefined ? { byteSize: produced.byteSize } : {}),
              ...(produced.url ? { url: produced.url } : {}),
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
      setError(e instanceof Error ? e.message : t("run.failed"));
    } finally {
      // Whatever the last batch was holding, on every exit path: a run that
      // ends mid-interval would otherwise leave its last thought unshown.
      reasoningPacer.flush();
      setRunning(false);
    }
  }

  // The panel's own attachments are the source images an `image` project edits,
  // so a screenshot pasted into the prompt is the gesture this surface is for.
  const attach = useCallback((files: File[]) => void addFiles(files), [addFiles]);
  const { dragging, handlers } = useFileDrop(attach, running);
  const onPaste = useMemo(() => onFilePaste(attach, running), [attach, running]);

  return (
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
      {versionName === null ? (
        <Alert color="yellow" variant="light" fz="xs">
          Save a version to run it.
        </Alert>
      ) : (
        <Text fz="xs" c="dimmed">
          Running version{" "}
          <Text component="span" ff="monospace" fz="xs">
            {versionName}
          </Text>
        </Text>
      )}

      {needsMessage ? (
        <Textarea
          label={
            projectType === "image"
              ? attachments.length > 0
                ? t("run.editLabel")
                : t("run.imagePromptLabel")
              : t("run.messageLabel")
          }
          value={message}
          onChange={(e) => setMessage(e.currentTarget.value)}
          onPaste={onPaste}
          autosize
          minRows={4}
          maxRows={16}
          placeholder={
            projectType === "image"
              ? attachments.length > 0
                ? t("run.editPlaceholder")
                : t("run.generatePlaceholder")
              : t("run.askPlaceholder")
          }
        />
      ) : varNames.length > 0 ? (
        <Input.Wrapper label={t("run.variables")} labelElement="div">
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
      ) : (
        <Text fz="xs" c="dimmed">
          {t("run.noVariables")}
        </Text>
      )}

      <Input.Wrapper
        label={projectType === "image" ? t("run.sourceImages") : t("run.images")}
        labelElement="div"
        description={attachHint}
        inputWrapperOrder={["label", "description", "input"]}
      >
        <Stack gap={4} mt={4}>
          <AttachmentBar attachments={attachments} attachError={attachError} onRemove={removeAt} />
          <Group>
            <AttachButton onPick={(files) => void addFiles(files)} disabled={running} />
          </Group>
          {modelAcceptsImages === false && attachments.length > 0 && (
            <Text fz="xs" c="red">
              {projectType === "image" ? t("run.cannotEdit") : t("run.noImageInput")}
            </Text>
          )}
        </Stack>
      </Input.Wrapper>

      {projectType === "image" && (
        <Group gap="sm" align="flex-end">
          <Select
            label={t("run.size")}
            value={size}
            onChange={(value) => setSize(value ?? "1024x1024")}
            allowDeselect={false}
            data={["1024x1024", "1536x1024", "1024x1536"]}
          />
          <Select
            label={t("run.quality")}
            value={quality}
            onChange={(value) => setQuality(value ?? "medium")}
            allowDeselect={false}
            data={["low", "medium", "high"]}
          />
        </Group>
      )}

      <Group>
        <Button onClick={run} loading={running} disabled={!canRun}>
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
              {projectName}
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
        // Same identity the chat and Compare use: the run's own start, stable
        // for its whole life. A new one per Run, so collapsing the panel once
        // does not switch off the auto-open for every later run; and nothing
        // that changes at the finish, which would shut it as the answer lands.
        key={`reasoning-${startedAt}`}
        text={reasoning}
        {...(reasoningTokens > 0 ? { tokens: reasoningTokens } : {})}
        streaming={running && text === "" && reasoning !== ""}
      />

      {projectType === "image" ? (
        <Paper withBorder p="sm" mih={96}>
          {image ? (
            <Image
              src={imageDataUrl({ b64: image.imageBase64, mimeType: image.mimeType })}
              alt={t("chat.generatedImage")}
              radius="sm"
              onClick={(e) => view({ src: e.currentTarget.src, alt: e.currentTarget.alt })}
              style={{ cursor: "zoom-in" }}
            />
          ) : (
            <Text fz="sm" c="dimmed">
              {running ? t("run.generating") : t("run.imageWillAppear")}
            </Text>
          )}
        </Paper>
      ) : (
        <Paper withBorder p="sm" mih={96} style={{ whiteSpace: "pre-wrap" }}>
          {text || (
            <Text fz="sm" c="dimmed">
              {t("run.outputWillStream")}
            </Text>
          )}
        </Paper>
      )}

      {agentImages.map((img, i) => (
        <Image
          key={`image-${i}`}
          src={imageDataUrl(img)}
          alt={img.prompt ?? t("chat.generatedImage")}
          radius="md"
          onClick={(e) =>
            view({
              src: e.currentTarget.src,
              alt: e.currentTarget.alt,
              title: t("chat.generatedImage"),
              ...(img.prompt ? { caption: img.prompt } : {}),
            })
          }
          style={{ cursor: "zoom-in" }}
        />
      ))}

      {/* The same row the chat draws. A run that renders a document answers
          with it, and this surface used to show the picture beside it and
          nothing else. */}
      {agentFiles.map((file, i) => (
        <ProducedFile key={`file-${i}`} name={file.name} byteSize={file.byteSize} url={file.url} />
      ))}

      {/* The same paired rows the chat draws — one row per call, badged by what
          kind of thing ran, named with what it actually did. Two accordion
          lists (calls, then results) were this surface's own rendering of the
          same wire format, and they had already drifted from the chat's. */}
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
  );
}
