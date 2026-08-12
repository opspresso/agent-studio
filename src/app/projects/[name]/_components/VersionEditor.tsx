"use client";

import { useEffect, useState } from "react";
import { listAgents } from "@/app/agents/api";
import { listSkills } from "@/app/skills/api";
import { listMcps } from "@/app/tools/api";
import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Code,
  Group,
  List,
  Modal,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { IconHelp } from "@tabler/icons-react";
import { CodeBlock } from "@/app/_components/CodeBlock";
import { CopyButton } from "@/app/_components/CopyButton";
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
import { SUBAGENT_KIND_COLOR } from "@/app/_components/badgeColors";

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
                  badgeColor: SUBAGENT_KIND_COLOR.local,
                  type: "local" as const,
                }))
            : [];
        const remotes: SubagentOption[] =
          agents.status === "fulfilled"
            ? agents.value.map((a) => ({
                value: a.name,
                description: a.description,
                badge: "remote",
                badgeColor: SUBAGENT_KIND_COLOR.remote,
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
  const [schemaHelpOpen, setSchemaHelpOpen] = useState(false);

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

      {/* Retried on a completion failure — a path an image run does not have. */}
      {projectType !== "image" &&
        (models.length > 0 ? (
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
        ))}

      <Textarea
        label="System prompt"
        value={value.systemPrompt}
        onChange={(e) => patch({ systemPrompt: e.currentTarget.value })}
        placeholder={
          projectType === "image"
            ? "Watercolor style, soft pastel tones, no text in the image."
            : "You are a helpful assistant."
        }
        description={
          projectType === "image"
            ? "Prepended to every image prompt as the version's persistent style."
            : undefined
        }
        autosize
        minRows={8}
        maxRows={30}
        styles={monoInput}
      />

      {/*
        An agent run never sends the template, so the field would only invite
        text with nowhere to go. It stays visible while it holds leftover
        content, so that content can be seen and cleared — clearing it makes
        the field disappear.
      */}
      {(projectType !== "agent" || value.userPromptTemplate !== "") && (
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
              {projectType === "agent" ? (
                "Agent runs ignore this template — the conversation supplies the user turn. Clear it to remove this field."
              ) : (
                <>Use {"{{variable}}"} placeholders rendered server-side at run time.</>
              )}
            </Text>
            {projectType !== "agent" && (
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
            )}
          </Group>
        </div>
      )}

      {/*
        Sampling parameters ride the chat channel (`buildChannelParams`); an
        image run sends only prompt, size and quality, so none of these reach
        it and offering them would store settings that do nothing.
      */}
      {projectType !== "image" && (
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
      )}

      {projectType !== "image" && supportsReasoning && (
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

      {/*
        Neither filter nor caller block exists on the image path — each stays
        visible only while a stored value needs to be seen and turned off.
      */}
      {(projectType !== "image" || value.parameters.piiFiltering) && (
        <Checkbox
          label="PII filtering"
          description={
            projectType === "image"
              ? "Does not apply to an image run — the prompt reaches the provider unmasked. Uncheck to remove this option."
              : "Masks emails, phone numbers, Korean registration numbers and card numbers with reversible tokens before dispatch. What an MCP tool receives is not masked."
          }
          checked={value.parameters.piiFiltering}
          onChange={(e) => patchParams({ piiFiltering: e.currentTarget.checked })}
        />
      )}

      {(projectType !== "image" || value.parameters.callerContext) && (
        <Checkbox
          label="Tell the run who is asking (name, timezone)"
          description={
            projectType === "image"
              ? "Does not apply to an image run — its prompt has no caller block. Uncheck to remove this option."
              : "Anywhere a person runs it — chat, Playground, a signed-in API call, Slack. An API token, a trigger and inbound A2A carry no caller. PII filtering does not mask a name."
          }
          checked={value.parameters.callerContext ?? false}
          onChange={(e) => patchParams({ callerContext: e.currentTarget.checked })}
        />
      )}

      {projectType !== "image" && supportsStructured && (
        <Stack gap="xs">
          <Group gap={6} wrap="nowrap">
            <Checkbox
              label="Structured output (JSON schema)"
              checked={value.parameters.structuredOutput ?? false}
              onChange={(e) => patchParams({ structuredOutput: e.currentTarget.checked })}
            />
            <ActionIcon
              size="sm"
              aria-label="About structured output"
              onClick={() => setSchemaHelpOpen(true)}
            >
              <IconHelp size={15} stroke={1.7} />
            </ActionIcon>
          </Group>
          <StructuredOutputHelp
            opened={schemaHelpOpen}
            onClose={() => setSchemaHelpOpen(false)}
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

      {(runsTools || value.parameters.urlFetch) && (
        <Stack gap="xs">
          <Checkbox
            label="Read URLs (FetchUrl tool)"
            checked={value.parameters.urlFetch ?? false}
            onChange={(e) => patchParams({ urlFetch: e.currentTarget.checked ? true : undefined })}
          />
          <Text fz="xs" c="dimmed">
            Lets the agent read a web address it names — a page, a PDF, a data file or an image.
            Off by default: every other outbound request goes somewhere an operator registered,
            while this one goes wherever the model decides.
          </Text>
        </Stack>
      )}

      {(runsTools || hasToolBindings) && (
        <Stack gap="sm">
          {!runsTools && (
            <Alert color="yellow" variant="light" fz="xs">
              {projectType === "image"
                ? "An \"image\" project draws from a prompt and offers no tools — the bindings below are stored but never used. Remove them here; new ones cannot be added."
                : "An \"llm\" project runs a single completion, which offers no tools — the bindings below are stored but never used. Remove them here; new ones cannot be added."}
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
          {runsTools && (
            <Checkbox
              label="Find capabilities for each request"
              description="Searches the registry with this version's system prompt and the incoming request, and offers what it finds on top of the bindings above. The bindings are always offered in full. An MCP server that needs its own sign-in is offered only once this project has connected it — a connection is made from that server's own settings and shared by every version, so it counts here even where this version never bound the server."
              checked={value.parameters.dynamicCapabilities ?? false}
              onChange={(e) => patchParams({ dynamicCapabilities: e.currentTarget.checked })}
            />
          )}
        </Stack>
      )}
    </Stack>
  );
}

const SAMPLE_SCHEMA = JSON.stringify(
  {
    type: "object",
    properties: {
      answer: { type: "string", description: "The reply to show the user, one or two sentences" },
      sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
      score: { type: "number", description: "Confidence between 0 and 1" },
    },
    required: ["answer", "sentiment", "score"],
    additionalProperties: false,
  },
  null,
  2,
);

const SAMPLE_REPLY = JSON.stringify(
  {
    answer: "This review is positive — delivery speed stands out.",
    sentiment: "positive",
    score: 0.87,
  },
  null,
  2,
);

function StructuredOutputHelp({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  return (
    <Modal opened={opened} onClose={onClose} title="Structured output" size="lg">
      <Stack gap="sm">
        <Text fz="sm" lh={1.6}>
          With the checkbox on and a schema filled in, the model&apos;s reply is a single JSON
          document matching the schema — sent as <Code>response_format: json_schema</Code>. There
          is no prose around it: give the schema a field for any sentence the model should write,
          and have your caller parse the reply as JSON.
        </Text>
        <List spacing={4} fz="sm">
          <List.Item>
            The root must be an <Code>object</Code>. Mark every property <Code>required</Code> and
            set <Code>additionalProperties: false</Code> — the strictest providers accept exactly
            that shape.
          </List.Item>
          <List.Item>
            Each property&apos;s <Code>description</Code> is the instruction the model reads for
            that field; longer guidance belongs in the system prompt.
          </List.Item>
          <List.Item>
            The checkbox alone does nothing — with an empty schema no{" "}
            <Code>response_format</Code> is sent and the reply stays plain text.
          </List.Item>
        </List>
        <Group justify="space-between" gap="xs">
          <Text fz="xs" fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: "0.05em" }}>
            Sample schema
          </Text>
          <CopyButton text={SAMPLE_SCHEMA} />
        </Group>
        <CodeBlock language="json" code={SAMPLE_SCHEMA} />
        <Text fz="xs" fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: "0.05em" }}>
          What the model returns
        </Text>
        <CodeBlock language="json" code={SAMPLE_REPLY} />
      </Stack>
    </Modal>
  );
}
