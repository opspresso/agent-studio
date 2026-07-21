"use client";

import { useState } from "react";
import type { ModelConfig, ProjectType, VersionInput, VersionParameters } from "../../lib/api";
import { Field, NumberField, SubagentInput, TagInput, inputClass } from "./inputs";

export function VersionEditor({
  projectType,
  models,
  value,
  onChange,
}: {
  projectType: ProjectType;
  models: ModelConfig[];
  value: VersionInput;
  onChange: (value: VersionInput) => void;
}) {
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
        <textarea
          value={value.systemPrompt}
          onChange={(e) => patch({ systemPrompt: e.target.value })}
          rows={5}
          placeholder="You are a helpful assistant."
          className={`${inputClass} font-mono`}
        />
      </Field>

      <Field label="User prompt template">
        <textarea
          value={value.userPromptTemplate}
          onChange={(e) => patch({ userPromptTemplate: e.target.value })}
          rows={4}
          placeholder="Summarize: {{input}}"
          className={`${inputClass} font-mono`}
        />
        <span className="mt-1 block text-xs text-neutral-400">
          Use {"{{variable}}"} placeholders rendered server-side at run time.
        </span>
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

      <TagInput
        label="MCP servers"
        values={value.mcpList}
        onChange={(mcpList) => patch({ mcpList })}
        placeholder="Add MCP server name and press Enter"
      />
      <TagInput
        label="Skills"
        values={value.skillList}
        onChange={(skillList) => patch({ skillList })}
        placeholder="Add skill name and press Enter"
      />
      <SubagentInput values={value.subagentList} onChange={(subagentList) => patch({ subagentList })} />
    </div>
  );
}
