"use client";

import { useMemo, useState } from "react";
import type { EngineChunk, ImageResult, ProjectType } from "../../lib/api";
import { predictImage, readSse, streamAgent, streamPredict } from "../../lib/api";
import { parseWireToolCall } from "@/app/_lib/toolCalls";
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

/**
 * Keep only the deepest chains seen: a run that reached
 * `sample-agent → simple-image` also produced `sample-agent` chunks, and listing
 * both reads as two separate agents.
 */
function mergePath(seen: string[][], path: string[]): string[][] {
  // The trailing separator keeps the comparison on whole names: without it `img`
  // reads as a chain prefix of the unrelated agent `image-agent`.
  const key = (p: string[]) => `${p.join(">")}>`;
  if (seen.some((existing) => key(existing).startsWith(key(path)))) {
    return seen;
  }
  return [...seen.filter((existing) => !key(path).startsWith(key(existing))), path];
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
  const [activePath, setActivePath] = useState<string[] | undefined>(undefined);
  const [visitedPaths, setVisitedPaths] = useState<string[][]>([]);
  const [error, setError] = useState<string | null>(null);
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
    setActivePath(undefined);
    setVisitedPaths([]);
    setError(null);
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
          setError(chunk.error);
          // A subagent failure is reported to the parent as a tool error and the
          // parent may still answer; only a top-level error ends the run.
          if (isTopLevelChunk(chunk)) {
            break;
          }
          continue;
        }
        // Track who is running: an authored chunk names the innermost agent (and
        // its chain); an unauthored one means control is back at the top level.
        const path = chunk.authorPath ?? (chunk.author ? [chunk.author] : undefined);
        setActivePath(path);
        if (path) {
          setVisitedPaths((prev) => mergePath(prev, path));
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
                onChange={(e) =>
                  setVariables((prev) => ({ ...prev, [name]: e.currentTarget.value }))
                }
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

      {(activePath || visitedPaths.length > 0) && (
        <Stack gap={4}>
          <Group gap={6} wrap="wrap">
            <Text fz="xs" c="dimmed">
              {running ? "running:" : "ran:"}
            </Text>
            <Badge color={BADGE.owned} ff="monospace">
              {projectName}
            </Badge>
            {(activePath ?? []).map((agent, index) => (
              <Group key={`active-${index}`} gap={6} wrap="nowrap">
                <Text fz="xs" c="dimmed">
                  →
                </Text>
                <Badge color={SUBAGENT_COLOR} ff="monospace">
                  {agent}
                </Badge>
              </Group>
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
                  🔧 tool call: {call.name}
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
