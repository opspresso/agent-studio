"use client";

import { useEffect, useState } from "react";
import { listAgents } from "@/app/agents/api";
import { listSkills } from "@/app/skills/api";
import { listMcps } from "@/app/tools/api";
import { ResizableTextarea } from "@/app/_components/ResizableTextarea";
import { listProjects } from "../../lib/api";
import type { ModelConfig, ProjectType, VersionInput, VersionParameters } from "../../lib/api";
import {
  Field,
  McpBindingInput,
  NumberField,
  SearchSelectInput,
  SubagentInput,
  inputClass,
} from "./inputs";
import type { PickerOption } from "./inputs";

type SubagentOption = PickerOption & { type: "local" | "remote" };

export function VersionEditor({
  projectName,
  projectType,
  models,
  imageModels,
  value,
  onChange,
}: {
  projectName: string;
  projectType: ProjectType;
  models: ModelConfig[];
  imageModels: ModelConfig[];
  value: VersionInput;
  onChange: (value: VersionInput) => void;
}) {
  const [mcpOptions, setMcpOptions] = useState<PickerOption[]>([]);
  const [skillOptions, setSkillOptions] = useState<PickerOption[]>([]);
  const [subagentOptions, setSubagentOptions] = useState<SubagentOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([listMcps(), listSkills(), listProjects(), listAgents()]).then(
      ([mcps, skills, projects, agents]) => {
        if (cancelled) {
          return;
        }
        if (mcps.status === "fulfilled") {
          setMcpOptions(
            mcps.value.map((m) => ({ value: m.name, description: m.description })),
          );
        }
        if (skills.status === "fulfilled") {
          setSkillOptions(
            skills.value.map((s) => ({ value: s.name, description: s.description })),
          );
        }
        const locals: SubagentOption[] =
          projects.status === "fulfilled"
            ? projects.value
                .filter((p) => p.publishedVersion && p.name !== projectName)
                .map((p) => ({
                  value: p.name,
                  description: p.description,
                  badge: "local",
                  type: "local" as const,
                }))
            : [];
        const remotes: SubagentOption[] =
          agents.status === "fulfilled"
            ? agents.value.map((a) => ({
                value: a.name,
                description: a.description,
                badge: "remote",
                type: "remote" as const,
              }))
            : [];
        setSubagentOptions([...locals, ...remotes]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectName]);
  const [schemaText, setSchemaText] = useState(() =>
    value.parameters.jsonSchema ? JSON.stringify(value.parameters.jsonSchema, null, 2) : "",
  );
  const [schemaError, setSchemaError] = useState<string | null>(null);

  const selectedModel = models.find((m) => m.id === value.model);
  const supportsReasoning = selectedModel?.capabilities.reasoning ?? true;
  const supportsStructured = selectedModel?.capabilities.structuredOutput ?? true;

  function patch(next: Partial<VersionInput>) {
    onChange({ ...value, ...next });
  }
  function patchParams(next: Partial<VersionParameters>) {
    onChange({ ...value, parameters: { ...value.parameters, ...next } });
  }

  function onSchemaChange(text: string) {
    setSchemaText(text);
    if (text.trim() === "") {
      setSchemaError(null);
      patchParams({ jsonSchema: undefined });
      return;
    }
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      setSchemaError(null);
      patchParams({ jsonSchema: parsed });
    } catch {
      setSchemaError("Invalid JSON");
    }
  }

  return (
    <div className="space-y-4">
      <Field label="Model">
        {models.length > 0 ? (
          <select
            value={value.model}
            onChange={(e) => patch({ model: e.target.value })}
            className={inputClass}
          >
            <option value="">Select a model…</option>
            {value.model && !selectedModel && <option value={value.model}>{value.model}</option>}
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName} ({model.id})
              </option>
            ))}
          </select>
        ) : (
          <input
            value={value.model}
            onChange={(e) => patch({ model: e.target.value })}
            placeholder="openai/gpt-5-mini"
            className={inputClass}
          />
        )}
        {value.model && models.length > 0 && !selectedModel && (
          <p className="mt-1 text-xs text-red-500">
            Model is not in the catalog; usage will be recorded with $0 cost.
          </p>
        )}
      </Field>

      <Field label="Fallback model (optional)">
        {models.length > 0 ? (
          <select
            value={value.fallbackModel ?? ""}
            onChange={(e) => patch({ fallbackModel: e.target.value || undefined })}
            className={inputClass}
          >
            <option value="">None</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayName}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={value.fallbackModel ?? ""}
            onChange={(e) => patch({ fallbackModel: e.target.value || undefined })}
            className={inputClass}
          />
        )}
      </Field>

      <Field label="System prompt">
        <ResizableTextarea
          value={value.systemPrompt}
          onChange={(systemPrompt) => patch({ systemPrompt })}
          rows={8}
          placeholder="You are a helpful assistant."
          className={`${inputClass} font-mono`}
        />
      </Field>

      <Field label="User prompt template">
        <ResizableTextarea
          value={value.userPromptTemplate}
          onChange={(userPromptTemplate) => patch({ userPromptTemplate })}
          rows={4}
          placeholder="Summarize: {{input}}"
          className={`${inputClass} font-mono`}
          footerLeft={
            <span className="text-xs text-neutral-400">
              Use {"{{variable}}"} placeholders rendered server-side at run time.
            </span>
          }
          footerRight={
            <button
              type="button"
              onClick={() =>
                patch({
                  userPromptTemplate: value.userPromptTemplate
                    ? `${value.userPromptTemplate}{{input}}`
                    : "{{input}}",
                })
              }
              className="shrink-0 rounded bg-neutral-100 px-2 py-0.5 font-mono text-xs text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
            >
              + {"{{input}}"}
            </button>
          }
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="Temperature"
          value={value.parameters.temperature}
          onChange={(temperature) => patchParams({ temperature })}
          step={0.1}
          min={0}
          max={2}
          placeholder="default"
        />
        <NumberField
          label="Max tokens"
          value={value.parameters.maxTokens}
          onChange={(maxTokens) => patchParams({ maxTokens })}
          step={1}
          min={1}
          placeholder="default"
        />
      </div>

      {supportsReasoning && (
        <Field label="Reasoning effort">
          <select
            value={value.parameters.reasoningEffort ?? ""}
            onChange={(e) =>
              patchParams({
                reasoningEffort: (e.target.value || undefined) as VersionParameters["reasoningEffort"],
              })
            }
            className={inputClass}
          >
            <option value="">Default</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </Field>
      )}

      {projectType === "agent" && (
        <NumberField
          label="Max turns"
          value={value.maxTurn}
          onChange={(maxTurn) => patch({ maxTurn })}
          step={1}
          min={1}
          placeholder="50"
        />
      )}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.parameters.piiFiltering}
          onChange={(e) => patchParams({ piiFiltering: e.target.checked })}
        />
        PII filtering
      </label>

      {supportsStructured && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={value.parameters.structuredOutput ?? false}
              onChange={(e) => patchParams({ structuredOutput: e.target.checked })}
            />
            Structured output (JSON schema)
          </label>
          {value.parameters.structuredOutput && (
            <div>
              <textarea
                value={schemaText}
                onChange={(e) => onSchemaChange(e.target.value)}
                rows={5}
                placeholder='{"type":"object","properties":{}}'
                className={`${inputClass} font-mono`}
              />
              {schemaError && <p className="mt-1 text-xs text-red-500">{schemaError}</p>}
            </div>
          )}
        </div>
      )}

      {projectType !== "image" && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={value.parameters.imageGeneration ?? false}
              onChange={(e) =>
                patchParams(
                  e.target.checked
                    ? { imageGeneration: true }
                    : { imageGeneration: undefined, imageModel: undefined },
                )
              }
            />
            Image generation (GenerateImage tool)
          </label>
          {value.parameters.imageGeneration && (
            <Field label="Image model">
              <select
                value={value.parameters.imageModel ?? ""}
                onChange={(e) => patchParams({ imageModel: e.target.value || undefined })}
                className={inputClass}
              >
                <option value="">Default</option>
                {imageModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName} ({model.id})
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      )}

      <McpBindingInput
        values={value.mcpList}
        onChange={(mcpList) => patch({ mcpList })}
        options={mcpOptions}
      />
      <SearchSelectInput
        label="Skills"
        values={value.skillList}
        onChange={(skillList) => patch({ skillList })}
        options={skillOptions}
        placeholder="Search registered skills"
      />
      <SubagentInput
        values={value.subagentList}
        onChange={(subagentList) => patch({ subagentList })}
        options={subagentOptions}
      />
    </div>
  );
}
