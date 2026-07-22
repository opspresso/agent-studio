"use client";

import { useMemo, useState } from "react";
import type { EngineChunk, ImageResult, ProjectType } from "../../lib/api";
import { predictImage, readSse, streamAgent, streamPredict } from "../../lib/api";
import { parseWireToolCall } from "@/app/_lib/toolCalls";
import { inputClass } from "./inputs";

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
}: {
  projectName: string;
  versionName: string | null;
  projectType: ProjectType;
  systemPrompt: string;
  userPromptTemplate: string;
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
  const [author, setAuthor] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const [image, setImage] = useState<ImageResult | null>(null);
  const [agentImages, setAgentImages] = useState<
    Array<{ b64: string; mimeType: string; prompt?: string }>
  >([]);
  const [size, setSize] = useState("1024x1024");
  const [quality, setQuality] = useState("medium");

  const needsMessage = projectType === "agent" || projectType === "image";
  const canRun = versionName !== null && !running && (!needsMessage || message.trim() !== "");

  async function run() {
    if (versionName === null) {
      return;
    }
    setRunning(true);
    setText("");
    setToolCalls([]);
    setToolResults([]);
    setAuthor(undefined);
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
        });
        setImage(result);
        setCost(result.usage.costUsd);
        return;
      }
      const res =
        projectType === "agent"
          ? await streamAgent(projectName, versionName, [{ role: "user", content: message }])
          : await streamPredict(projectName, versionName, { variables });

      for await (const chunk of readSse(res) as AsyncGenerator<EngineChunk>) {
        if (chunk.error) {
          setError(chunk.error);
          break;
        }
        if (chunk.author) {
          setAuthor(chunk.author);
        }
        const content = chunk.delta?.content;
        if (content && !chunk.author) {
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
    <div className="space-y-4">
      {versionName === null ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          Save a version to run it.
        </p>
      ) : (
        <p className="text-xs text-neutral-400">
          Running version <span className="font-mono">{versionName}</span>
        </p>
      )}

      {needsMessage ? (
        <label className="block">
          <span className="text-sm font-medium">{projectType === "image" ? "Image prompt" : "Message"}</span>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
            placeholder={projectType === "image" ? "Describe the image to generate…" : "Ask the agent…"}
            className={`${inputClass} mt-1`}
          />
        </label>
      ) : varNames.length > 0 ? (
        <div className="space-y-2">
          <span className="text-sm font-medium">Variables</span>
          {varNames.map((name) => (
            <label key={name} className="flex items-center gap-2">
              <span className="w-32 shrink-0 font-mono text-xs text-neutral-500">{name}</span>
              <input
                value={variables[name] ?? ""}
                onChange={(e) => setVariables((prev) => ({ ...prev, [name]: e.target.value }))}
                className={inputClass}
              />
            </label>
          ))}
        </div>
      ) : (
        <p className="text-xs text-neutral-400">No template variables detected.</p>
      )}

      {projectType === "image" && (
        <div className="flex gap-3">
          <label className="block">
            <span className="text-xs text-neutral-500">Size</span>
            <select value={size} onChange={(e) => setSize(e.target.value)} className={`${inputClass} mt-1`}>
              <option value="1024x1024">1024×1024</option>
              <option value="1536x1024">1536×1024</option>
              <option value="1024x1536">1024×1536</option>
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-neutral-500">Quality</span>
            <select value={quality} onChange={(e) => setQuality(e.target.value)} className={`${inputClass} mt-1`}>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>
        </div>
      )}

      <button
        type="button"
        onClick={run}
        disabled={!canRun}
        className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-strong disabled:opacity-50"
      >
        {running ? "Running…" : "Run"}
      </button>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {author && (
        <span className="inline-block rounded bg-violet-100 px-2 py-0.5 text-xs text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
          author: {author}
        </span>
      )}

      {projectType === "image" ? (
        <div className="min-h-24 rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`data:${image.mimeType};base64,${image.imageBase64}`}
              alt="Generated image"
              className="max-w-full rounded"
            />
          ) : (
            <span className="text-sm text-neutral-400">
              {running ? "Generating image… this can take a minute." : "Generated image will appear here."}
            </span>
          )}
        </div>
      ) : (
        <div className="min-h-24 whitespace-pre-wrap rounded-md border border-neutral-200 bg-white p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
          {text || <span className="text-neutral-400">Output will stream here.</span>}
        </div>
      )}

      {agentImages.map((img, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={`image-${i}`}
          src={`data:${img.mimeType};base64,${img.b64}`}
          alt={img.prompt ?? "Generated image"}
          className="max-w-full rounded-md border border-neutral-200 dark:border-neutral-800"
        />
      ))}

      {toolCalls.map((call, i) => (
        <details key={`call-${i}`} className="rounded-md border border-neutral-200 dark:border-neutral-800">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
            🔧 tool call: {call.name}
            {call.author && <span className="ml-1 text-neutral-400">({call.author})</span>}
          </summary>
          <pre className="overflow-x-auto px-3 pb-2 text-xs">{call.args}</pre>
        </details>
      ))}

      {toolResults.map((result, i) => (
        <details key={`result-${i}`} className="rounded-md border border-neutral-200 dark:border-neutral-800">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
            ✅ tool result: {result.name}
            {result.author && <span className="ml-1 text-neutral-400">({result.author})</span>}
          </summary>
          <pre className="overflow-x-auto px-3 pb-2 text-xs">{result.content}</pre>
        </details>
      ))}

      {cost !== null && (
        <p className="text-xs text-neutral-400">est. cost: ${cost.toFixed(6)}</p>
      )}
    </div>
  );
}
