"use client";

import { useEffect, useState } from "react";
import { listAgents } from "@/app/agents/api";
import { listSkills } from "@/app/skills/api";
import { listMcps } from "@/app/tools/api";
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { monoInput } from "@/app/_components/monoInput";
import { listProjects } from "../../lib/api";
import type { ModelConfig, ProjectType, VersionInput, VersionParameters } from "../../lib/api";
import {
  LabeledField,
  McpBindingInput,
  NumberField,
  SearchSelectInput,
  SubagentInput,
} from "./inputs";
import type { PickerOption } from "./inputs";
import type { VersionSave } from "./McpBindingSettings";

type SubagentOption = PickerOption & { type: "local" | "remote" };

export function VersionEditor({
  projectName,
  projectType,
  models,
  imageModels,
  value,
  onChange,
  save,
}: {
  projectName: string;
  projectType: ProjectType;
  models: ModelConfig[];
  imageModels: ModelConfig[];
  value: VersionInput;
  onChange: (value: VersionInput) => void;
  /** Passed through to the MCP settings dialog, which covers the page's Save. */
  save: VersionSave;
}) {
  const [mcpOptions, setMcpOptions] = useState<PickerOption[]>([]);
  const [skillOptions, setSkillOptions] = useState<PickerOption[]>([]);
  const [subagentOptions, setSubagentOptions] = useState<SubagentOption[]>([]);
  // Only agent projects run the tool loop. The inputs below stay visible on the
  // other types when something is already bound, so a version stored before
  // this rule can still be cleaned up instead of holding dead configuration.
  const runsTools = projectType === "agent";
  const hasToolBindings =
    value.mcpList.length > 0 || value.skillList.length > 0 || value.subagentList.length > 0;

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
    <Stack gap="md">
      {models.length > 0 ? (
        <Select
          label="Model"
          value={value.model}
          onChange={(model) => patch({ model: model ?? "" })}
          placeholder="Select a model…"
          searchable
          data={[
            // A stored model missing from the catalog stays selectable so a
            // version can be saved without silently losing it.
            ...(value.model && !selectedModel ? [{ value: value.model, label: value.model }] : []),
            ...models.map((model) => ({
              value: model.id,
              label: `${model.displayName} (${model.id})`,
            })),
          ]}
          error={
            value.model && !selectedModel
              ? "Model is not in the catalog; usage will be recorded with $0 cost."
              : undefined
          }
        />
      ) : (
        <TextInput
          label="Model"
          value={value.model}
          onChange={(e) => patch({ model: e.currentTarget.value })}
          placeholder="openai/gpt-5-mini"
        />
      )}

      {models.length > 0 ? (
        <Select
          label="Fallback model (optional)"
          value={value.fallbackModel ?? null}
          onChange={(fallbackModel) => patch({ fallbackModel: fallbackModel ?? undefined })}
          placeholder="None"
          clearable
          searchable
          data={models.map((model) => ({ value: model.id, label: model.displayName }))}
        />
      ) : (
        <TextInput
          label="Fallback model (optional)"
          value={value.fallbackModel ?? ""}
          onChange={(e) => patch({ fallbackModel: e.currentTarget.value || undefined })}
        />
      )}

      <Textarea
        label="System prompt"
        value={value.systemPrompt}
        onChange={(e) => patch({ systemPrompt: e.currentTarget.value })}
        placeholder="You are a helpful assistant."
        autosize
        minRows={8}
        maxRows={30}
        styles={monoInput}
      />

      <div>
        <Textarea
          label="User prompt template"
          value={value.userPromptTemplate}
          onChange={(e) => patch({ userPromptTemplate: e.currentTarget.value })}
          placeholder="Summarize: {{input}}"
          autosize
          minRows={4}
          maxRows={20}
          styles={monoInput}
        />
        <Group justify="space-between" gap="xs" mt={4} wrap="nowrap">
          <Text fz="xs" c="dimmed">
            Use {"{{variable}}"} placeholders rendered server-side at run time.
          </Text>
          <Button
            variant="default"
            size="compact-xs"
            ff="monospace"
            onClick={() =>
              patch({
                userPromptTemplate: value.userPromptTemplate
                  ? `${value.userPromptTemplate}{{input}}`
                  : "{{input}}",
              })
            }
          >
            + {"{{input}}"}
          </Button>
        </Group>
      </div>

      <SimpleGrid cols={2} spacing="sm">
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
      </SimpleGrid>

      {supportsReasoning && (
        <Select
          label="Reasoning effort"
          value={value.parameters.reasoningEffort ?? ""}
          onChange={(effort) =>
            patchParams({
              reasoningEffort: (effort || undefined) as VersionParameters["reasoningEffort"],
            })
          }
          allowDeselect={false}
          data={[
            { value: "", label: "Default" },
            { value: "low", label: "low" },
            { value: "medium", label: "medium" },
            { value: "high", label: "high" },
          ]}
        />
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

      <Checkbox
        label="PII filtering"
        checked={value.parameters.piiFiltering}
        onChange={(e) => patchParams({ piiFiltering: e.currentTarget.checked })}
      />

      {supportsStructured && (
        <Stack gap="xs">
          <Checkbox
            label="Structured output (JSON schema)"
            checked={value.parameters.structuredOutput ?? false}
            onChange={(e) => patchParams({ structuredOutput: e.currentTarget.checked })}
          />
          {value.parameters.structuredOutput && (
            <Textarea
              value={schemaText}
              onChange={(e) => onSchemaChange(e.currentTarget.value)}
              placeholder='{"type":"object","properties":{}}'
              autosize
              minRows={5}
              maxRows={20}
              error={schemaError}
              styles={monoInput}
            />
          )}
        </Stack>
      )}

      {(runsTools || value.parameters.imageGeneration) && (
        <Stack gap="xs">
          <Checkbox
            label="Images (GenerateImage + EditImage tools)"
            checked={value.parameters.imageGeneration ?? false}
            onChange={(e) =>
              patchParams(
                e.currentTarget.checked
                  ? { imageGeneration: true }
                  : { imageGeneration: undefined, imageModel: undefined },
              )
            }
          />
          <Text fz="xs" c="dimmed">
            Lets the agent draw a picture and change an existing one — an image the user attached,
            or one it drew earlier.
          </Text>
          {value.parameters.imageGeneration && (
            <Select
              label="Image model"
              value={value.parameters.imageModel ?? ""}
              onChange={(imageModel) => patchParams({ imageModel: imageModel || undefined })}
              allowDeselect={false}
              data={[
                { value: "", label: "Default" },
                ...imageModels.map((model) => ({
                  value: model.id,
                  label: `${model.displayName} (${model.id})`,
                })),
              ]}
            />
          )}
        </Stack>
      )}

      {(runsTools || hasToolBindings) && (
        <Stack gap="sm">
          {!runsTools && (
            <Alert color="yellow" variant="light" fz="xs">
              A &quot;{projectType}&quot; project runs a single completion, which offers no tools —
              the bindings below are stored but never used. Remove them here; new ones cannot be
              added.
            </Alert>
          )}
          <McpBindingInput
            projectName={projectName}
            values={value.mcpList}
            onChange={(mcpList) => patch({ mcpList })}
            options={mcpOptions}
            save={save}
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
        </Stack>
      )}
    </Stack>
  );
}
