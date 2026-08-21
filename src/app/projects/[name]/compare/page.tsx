"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  getProject,
  listVersions,
  predictImage,
  readSse,
  streamAgent,
  streamPredict,
  type EngineChunk,
  type ImageResult,
  type SanitizedProject,
  type Version,
} from "../../lib/api";
import { findTemplateVariables } from "@/shared/template";
import { formatUsd } from "@/app/_lib/formatUsd";
import { formatDuration } from "@/app/_lib/duration";
import { useT } from "@/app/_i18n/provider";
import { collectedWarning, imageDataUrl, isTopLevelChunk } from "@/domain/llm/types";
import {
  Alert,
  Badge,
  Button,
  Grid,
  Group,
  Image,
  Paper,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useImageViewer } from "@/app/_components/ImageViewer";
import { LoadingText } from "@/app/_components/PageState";
import { ProducedFile } from "@/app/_components/ProducedFile";
import { ReasoningRow } from "@/app/_components/ReasoningRow";

/**
 * One side's outcome, folded from the same chunk stream the playground reads —
 * deliberately lean: the point of this page is the answers next to each other,
 * not the full tool inspector the playground already is.
 */
interface SideResult {
  running: boolean;
  text: string;
  /** The run's thinking — empty unless this version opted into recording it. */
  reasoning: string;
  warnings: string[];
  error: string | null;
  costUsd: number | null;
  toolCallCount: number;
  durationMs: number | null;
  image: ImageResult | null;
  /** Pictures an agent run drew with its builtin image tool. */
  agentImages: Array<{ b64: string; mimeType: string }>;
  /** Documents a tool rendered, addressed by `/agent` on the way out. */
  agentFiles: Array<{ name: string; byteSize?: number; url?: string }>;
}

const IDLE: SideResult = {
  running: false,
  text: "",
  reasoning: "",
  warnings: [],
  error: null,
  costUsd: null,
  toolCallCount: 0,
  durationMs: null,
  image: null,
  agentImages: [],
  agentFiles: [],
};

function versionOptions(versions: Version[], published: string | undefined) {
  return versions.map((version) => ({
    value: version.versionName,
    label: `v${version.versionName}${published === version.versionName ? " (published)" : ""}`,
  }));
}

export default function ComparePage() {
  // Only the duration badge reads this so far; the rest of this page is still
  // untranslated, and taking the shared formatter is what brought it in.
  const t = useT();
  const params = useParams<{ name: string }>();
  const view = useImageViewer();
  const name = params.name;

  const [project, setProject] = useState<SanitizedProject | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [leftName, setLeftName] = useState<string | null>(null);
  const [rightName, setRightName] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [left, setLeft] = useState<SideResult>(IDLE);
  const [right, setRight] = useState<SideResult>(IDLE);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getProject(name), listVersions(name)])
      .then(([proj, vers]) => {
        if (cancelled) {
          return;
        }
        setProject(proj);
        setVersions(vers);
        // Published against the newest is the comparison the page exists for;
        // with no published version, the two newest stand in.
        const newestFirst = [...vers].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const published = vers.find((v) => v.versionName === proj.publishedVersion);
        const newest = newestFirst[0];
        const leftPick = published ?? newestFirst[1] ?? newest;
        setLeftName(leftPick?.versionName ?? null);
        setRightName(
          (newest?.versionName === leftPick?.versionName ? newestFirst[1] : newest)?.versionName ??
            newest?.versionName ??
            null,
        );
      })
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [name]);

  // The union of both sides' template variables, so one set of inputs feeds
  // whichever side declares each name.
  const varNames = useMemo(() => {
    const set = new Set<string>();
    for (const versionName of [leftName, rightName]) {
      const version = versions.find((v) => v.versionName === versionName);
      // Only the user prompt template is rendered with variables — a {{var}} in
      // the system prompt reaches the model as literal text, so it gets no field.
      for (const varName of findTemplateVariables(version?.userPromptTemplate ?? "")) {
        set.add(varName);
      }
    }
    return [...set];
  }, [versions, leftName, rightName]);

  const needsMessage = project?.projectType === "agent" || project?.projectType === "image";
  const running = left.running || right.running;
  const canRun =
    project !== null &&
    leftName !== null &&
    rightName !== null &&
    !running &&
    (!needsMessage || message.trim() !== "");

  async function runOne(
    versionName: string,
    setSide: (update: (prev: SideResult) => SideResult) => void,
  ) {
    if (!project) {
      return;
    }
    const startedAt = Date.now();
    setSide(() => ({ ...IDLE, running: true }));
    try {
      if (project.projectType === "image") {
        const result = await predictImage(name, versionName, { prompt: message });
        setSide((prev) => ({
          ...prev,
          image: result,
          costUsd: result.usage.costUsd,
          ...(result.warning ? { warnings: [...prev.warnings, result.warning] } : {}),
        }));
        return;
      }
      const res =
        project.projectType === "agent"
          ? await streamAgent(name, versionName, [{ role: "user", content: message }])
          : await streamPredict(name, versionName, { variables });
      for await (const chunk of readSse(res) as AsyncGenerator<EngineChunk>) {
        if (chunk.error) {
          // Only a top-level error is the run's; an authored one is a subagent
          // failure the parent may still answer from.
          if (isTopLevelChunk(chunk)) {
            setSide((prev) => ({ ...prev, error: chunk.error ?? "Run failed" }));
            break;
          }
          continue;
        }
        setSide((prev) => {
          const reported = collectedWarning(chunk, prev.warnings);
          return reported === undefined
            ? prev
            : { ...prev, warnings: [...prev.warnings, reported] };
        });
        const content = chunk.delta?.content;
        if (content && isTopLevelChunk(chunk)) {
          setSide((prev) => ({ ...prev, text: prev.text + content }));
        }
        const reasoned = chunk.delta?.reasoningContent;
        if (reasoned && isTopLevelChunk(chunk)) {
          setSide((prev) => ({ ...prev, reasoning: prev.reasoning + reasoned }));
        }
        const callCount = chunk.delta?.toolCalls?.length ?? 0;
        if (callCount > 0) {
          setSide((prev) => ({ ...prev, toolCallCount: prev.toolCallCount + callCount }));
        }
        if (chunk.image) {
          const generated = chunk.image;
          setSide((prev) => ({ ...prev, agentImages: [...prev.agentImages, generated] }));
        }
        if (chunk.file) {
          const produced = chunk.file;
          setSide((prev) => ({
            ...prev,
            agentFiles: [
              ...prev.agentFiles,
              {
                name: produced.name,
                ...(produced.byteSize !== undefined ? { byteSize: produced.byteSize } : {}),
                ...(produced.url ? { url: produced.url } : {}),
              },
            ],
          }));
        }
        if (chunk.usage) {
          const spent = chunk.usage.costUsd;
          setSide((prev) => ({ ...prev, costUsd: (prev.costUsd ?? 0) + spent }));
        }
      }
    } catch (e) {
      const failure = e instanceof Error ? e.message : "Run failed";
      setSide((prev) => ({ ...prev, error: failure }));
    } finally {
      setSide((prev) => ({ ...prev, running: false, durationMs: Date.now() - startedAt }));
    }
  }

  function run() {
    if (leftName === null || rightName === null) {
      return;
    }
    void runOne(leftName, setLeft);
    void runOne(rightName, setRight);
  }

  if (loading) {
    return <LoadingText />;
  }
  if (loadError || !project) {
    return (
      <Alert color="red" variant="light">
        {loadError ?? "Project not found"}
      </Alert>
    );
  }
  if (versions.length < 2) {
    return (
      <Alert color="yellow" variant="light">
        Save at least two versions to compare them.
      </Alert>
    );
  }

  const options = versionOptions(versions, project.publishedVersion);

  return (
    <Stack gap="md">
      <Stack gap="xs">
        {project.projectType !== "llm" && (
          <Textarea
            label={project.projectType === "image" ? "Prompt" : "Message"}
            value={message}
            onChange={(e) => setMessage(e.currentTarget.value)}
            autosize
            minRows={2}
          />
        )}
        {/* Only the predict path renders the template; an agent run takes the
            message as-is, so showing variable inputs there would collect values
            the run silently ignores (RunPanel draws none there either). */}
        {project.projectType === "llm" &&
          varNames.map((varName) => (
            <TextInput
              key={varName}
              label={varName}
              value={variables[varName] ?? ""}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setVariables((prev) => ({ ...prev, [varName]: value }));
              }}
            />
          ))}
        <Group>
          <Button onClick={run} loading={running} disabled={!canRun}>
            Run both
          </Button>
        </Group>
      </Stack>

      <Grid gap="lg">
        {(
          [
            [leftName, setLeftName, left],
            [rightName, setRightName, right],
          ] as const
        ).map(([sideName, setSideName, side], index) => (
          <Grid.Col key={index} span={{ base: 12, md: 6 }}>
            <Stack gap="xs">
              <Select
                value={sideName}
                onChange={(value) => value && setSideName(value)}
                allowDeselect={false}
                data={options}
              />
              <Paper withBorder p="md" radius="md">
                <Stack gap="xs">
                  {side.error && (
                    <Alert color="red" variant="light">
                      {side.error}
                    </Alert>
                  )}
                  {side.warnings.map((warning) => (
                    <Alert key={warning} color="yellow" variant="light" fz="xs">
                      {warning}
                    </Alert>
                  ))}
                  {/* Said rather than left out. With the section simply absent on
                      the version that did not opt in, the other side reads as the
                      one that thought harder — which is not what differs. */}
                  {versions.find((version) => version.versionName === sideName)?.parameters
                    .reasoningTrace ? (
                    <ReasoningRow
                      text={side.reasoning}
                      streaming={side.running && side.text === "" && side.reasoning !== ""}
                    />
                  ) : (
                    <Text fz="xs" c="dimmed">
                      Reasoning is not recorded for this version.
                    </Text>
                  )}
                  {side.image ? (
                    <Image
                      src={imageDataUrl({ b64: side.image.imageBase64, mimeType: side.image.mimeType })}
                      alt="Generated image"
                      radius="sm"
                      onClick={(e) =>
                        view({ src: e.currentTarget.src, alt: e.currentTarget.alt })
                      }
                      style={{ cursor: "zoom-in" }}
                    />
                  ) : (
                    <Text fz="sm" style={{ whiteSpace: "pre-wrap" }}>
                      {side.text || (side.running ? "…" : "Run to see this version's answer.")}
                    </Text>
                  )}
                  {side.agentImages.map((generated, imageIndex) => (
                    <Image
                      key={imageIndex}
                      src={imageDataUrl(generated)}
                      alt="Image drawn during the run"
                      radius="sm"
                      onClick={(e) =>
                        view({ src: e.currentTarget.src, alt: e.currentTarget.alt })
                      }
                      style={{ cursor: "zoom-in" }}
                    />
                  ))}
                  {/* Comparing two versions means comparing what each produced,
                      and a rendered document is as much of that as a picture. */}
                  {side.agentFiles.map((file, fileIndex) => (
                    <ProducedFile
                      key={`file-${fileIndex}`}
                      name={file.name}
                      byteSize={file.byteSize}
                      url={file.url}
                    />
                  ))}
                  <Group gap="xs">
                    {side.costUsd !== null && (
                      <Badge variant="light" color="teal">
                        {formatUsd(side.costUsd)}
                      </Badge>
                    )}
                    {side.durationMs !== null && (
                      <Badge variant="light" color="gray">
                        {formatDuration(side.durationMs, t)}
                      </Badge>
                    )}
                    {side.toolCallCount > 0 && (
                      <Badge variant="light" color="grape">
                        {side.toolCallCount} tool calls
                      </Badge>
                    )}
                  </Group>
                </Stack>
              </Paper>
            </Stack>
          </Grid.Col>
        ))}
      </Grid>
    </Stack>
  );
}
