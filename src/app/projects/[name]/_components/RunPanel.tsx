"use client";

import { useMemo, useState } from "react";
import type { EngineChunk, ImageResult, ProjectType } from "../../lib/api";
import { predictImage, readSse, streamAgent, streamPredict } from "../../lib/api";
import { describeTool, parseWireToolCall } from "@/app/_lib/toolCalls";
import {
  chunkAuthorPath,
  mergeVisitedPath,
  removeActivePath,
  trackActivePath,
} from "@/app/_lib/authorPaths";
import { toRequestImages } from "@/app/_lib/imageAttachments";
import { AttachButton, AttachmentBar, useAttachments } from "@/app/_components/ImageAttachments";
import { imageDataUrl, isTopLevelChunk } from "@/domain/llm/types";
import {
  Accordion,
  Alert,
  Badge,
  Button,
  Code,
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
  name: string;
  content: string;
  author?: string;
}
interface ToolCallView {
  name: string;
  args: string;
  author?: string;
}

function extractVariables(...sources: string[]): string[] {
  const set = new Set<string>();
  const re = /\{\{(\w+)\}\}/g;
  for (const src of sources) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(src)) !== null) {
      if (match[1]) {
        set.add(match[1]);
      }
    }
  }
  return [...set];
}

function toolCallView(raw: unknown, author?: string): ToolCallView {
  return { ...parseWireToolCall(raw), author };
}

export function RunPanel({
  projectName,
  versionName,
  projectType,
  systemPrompt,
  userPromptTemplate,
  modelAcceptsImages,
}: {
  projectName: string;
  versionName: string | null;
  projectType: ProjectType;
  systemPrompt: string;
  userPromptTemplate: string;
  /** From the model registry; `undefined` when the model is not in the catalog. */
  modelAcceptsImages?: boolean;
}) {
  const varNames = useMemo(
    () => extractVariables(systemPrompt, userPromptTemplate),
    [systemPrompt, userPromptTemplate],
  );
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");

  const [running, setRunning] = useState(false);
  const [text, setText] = useState("");
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
  const [size, setSize] = useState("1024x1024");
  const [quality, setQuality] = useState("medium");
  const { attachments, attachError, addFiles, removeAt } = useAttachments();

  const needsMessage = projectType === "agent" || projectType === "image";
  // An image-only turn is a legitimate run: "what is in this picture?" needs no words.
  const canRun =
    versionName !== null &&
    !running &&
    (!needsMessage || message.trim() !== "" || attachments.length > 0);
  const attachHint =
    projectType === "image"
      ? attachments.length > 0
        ? "The prompt edits these images."
        : "Attach an image to edit it instead of generating a new one."
      : "Attached images are sent with the run for the model to look at.";

  async function run() {
    if (versionName === null) {
      return;
    }
    setRunning(true);
    setText("");
    setToolCalls([]);
    setToolResults([]);
    setActivePaths([]);
    setVisitedPaths([]);
    setError(null);
    setWarnings([]);
    setCost(null);
    setImage(null);
    setAgentImages([]);
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
        if (chunk.warning) {
          const reported = chunk.warning;
          setWarnings((prev) => (prev.includes(reported) ? prev : [...prev, reported]));
        }
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
        if (chunk.delta?.toolCalls) {
          const calls = chunk.delta.toolCalls.map((c) => toolCallView(c, chunk.author));
          setToolCalls((prev) => [...prev, ...calls]);
        }
        if (chunk.toolResult) {
          const result: ToolResultView = {
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
        if (chunk.usage) {
          totalCost += chunk.usage.costUsd;
          setCost(totalCost);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Run failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Stack gap="md">
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
                ? "Edit instruction"
                : "Image prompt"
              : "Message"
          }
          value={message}
          onChange={(e) => setMessage(e.currentTarget.value)}
          autosize
          minRows={4}
          maxRows={16}
          placeholder={
            projectType === "image"
              ? attachments.length > 0
                ? "Describe the edited result…"
                : "Describe the image to generate…"
              : "Ask the agent…"
          }
        />
      ) : varNames.length > 0 ? (
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
      ) : (
        <Text fz="xs" c="dimmed">
          No template variables detected.
        </Text>
      )}

      <Input.Wrapper
        label={projectType === "image" ? "Source images" : "Images"}
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
              {projectType === "image"
                ? "This model cannot edit images; the run will be rejected."
                : "This model does not accept image input; the run will be rejected."}
            </Text>
          )}
        </Stack>
      </Input.Wrapper>

      {projectType === "image" && (
        <Group gap="sm" align="flex-end">
          <Select
            label="Size"
            value={size}
            onChange={(value) => setSize(value ?? "1024x1024")}
            allowDeselect={false}
            data={["1024x1024", "1536x1024", "1024x1536"]}
          />
          <Select
            label="Quality"
            value={quality}
            onChange={(value) => setQuality(value ?? "medium")}
            allowDeselect={false}
            data={["low", "medium", "high"]}
          />
        </Group>
      )}

      <Group>
        <Button onClick={run} loading={running} disabled={!canRun}>
          Run
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
              {running ? "running:" : "ran:"}
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
              agents involved: {visitedPaths.map((path) => path.join(" → ")).join(", ")}
            </Text>
          )}
        </Stack>
      )}

      {projectType === "image" ? (
        <Paper withBorder p="sm" mih={96}>
          {image ? (
            <Image
              src={imageDataUrl({ b64: image.imageBase64, mimeType: image.mimeType })}
              alt="Generated image"
              radius="sm"
            />
          ) : (
            <Text fz="sm" c="dimmed">
              {running
                ? "Generating image… this can take a minute."
                : "Generated image will appear here."}
            </Text>
          )}
        </Paper>
      ) : (
        <Paper withBorder p="sm" mih={96} style={{ whiteSpace: "pre-wrap" }}>
          {text || (
            <Text fz="sm" c="dimmed">
              Output will stream here.
            </Text>
          )}
        </Paper>
      )}

      {agentImages.map((img, i) => (
        <Image
          key={`image-${i}`}
          src={imageDataUrl(img)}
          alt={img.prompt ?? "Generated image"}
          radius="md"
        />
      ))}

      {(toolCalls.length > 0 || toolResults.length > 0) && (
        <Accordion variant="contained" chevronPosition="left" radius="md" multiple>
          {toolCalls.map((call, i) => (
            <Accordion.Item key={`call-${i}`} value={`call-${i}`}>
              <Accordion.Control>
                <Text fz="xs" fw={500}>
                  {/* `parseWireToolCall` hands back the tool's own name now, so
                      naming what actually ran — which skill, which agent — is
                      done here, where it was already being spelled out. */}
                  🔧 tool call: {describeTool(call.name, call.args).name}
                  {call.author && (
                    <Text component="span" c="dimmed" fz="xs" ml={4}>
                      ({call.author})
                    </Text>
                  )}
                </Text>
              </Accordion.Control>
              <Accordion.Panel>
                <Code block fz="xs">
                  {call.args}
                </Code>
              </Accordion.Panel>
            </Accordion.Item>
          ))}
          {toolResults.map((result, i) => (
            <Accordion.Item key={`result-${i}`} value={`result-${i}`}>
              <Accordion.Control>
                <Text fz="xs" fw={500}>
                  ✅ tool result: {result.name}
                  {result.author && (
                    <Text component="span" c="dimmed" fz="xs" ml={4}>
                      ({result.author})
                    </Text>
                  )}
                </Text>
              </Accordion.Control>
              <Accordion.Panel>
                <Code block fz="xs">
                  {result.content}
                </Code>
              </Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion>
      )}

      {cost !== null && (
        <Text fz="xs" c="dimmed">
          est. cost: ${cost.toFixed(6)}
        </Text>
      )}
    </Stack>
  );
}
