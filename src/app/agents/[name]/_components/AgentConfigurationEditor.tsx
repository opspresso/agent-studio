"use client";

import { useEffect, useState } from "react";
import { listSkills } from "@/app/skills/api";
import { listMcps } from "@/app/tools/api";
import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Code,
  Divider,
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
import { useT } from "@/app/_i18n/provider";
import { RuntimePolicyEditor } from "./RuntimePolicyEditor";
import { ModelRoutingEditor } from "./ModelRoutingEditor";
import { CodeBlock } from "@/app/_components/CodeBlock";
import { CopyButton } from "@/app/_components/CopyButton";
import { ModelSelect } from "@/app/_components/modelOptions";
import { monoInput } from "@/app/_components/monoInput";
import { listAgents } from "../../lib/api";
import { tierAtLeast } from "@/domain/member/tiers";
import { useViewer } from "@/app/_lib/useViewer";
import type { SelectableModel, AgentConfigurationInput, AgentParameters } from "../../lib/api";
import {
  McpBindingInput,
  NumberField,
  SearchSelectInput,
  SubagentInput,
} from "./inputs";
import type { PickerOption } from "./inputs";
import type { ConfigurationSave } from "./McpBindingSettings";
import { bindingsMayOfferRecall } from "@/domain/agent/memoryRecall";
import { PRESENCE_PENALTY_RANGE } from "@/domain/llm/channel";

/** Parse the JSON object the API accepts, without using a type assertion as validation. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseConfigurationDraft(value: AgentConfigurationInput, schemaText: string): AgentConfigurationInput | null {
  const jsonSchema = schemaText.trim() === "" ? undefined : parseJsonObject(schemaText);
  if (jsonSchema === null) {
    return value.parameters.structuredOutput ? null : value;
  }
  return { ...value, parameters: { ...value.parameters, jsonSchema } };
}

export function AgentConfigurationEditor({
  agentName,
  models,
  imageModels,
  value,
  onChange,
  schemaText,
  onSchemaChange,
  schemaError,
  save,
}: {
  agentName: string;
  models: SelectableModel[];
  imageModels: SelectableModel[];
  value: AgentConfigurationInput;
  onChange: (value: AgentConfigurationInput) => void;
  schemaText: string;
  onSchemaChange: (text: string) => void;
  schemaError: string | null;
  /** Passed through to the MCP settings dialog, which covers the page's Save. */
  save: ConfigurationSave;
}) {
  const t = useT();
  const [mcpOptions, setMcpOptions] = useState<PickerOption[]>([]);
  const [skillOptions, setSkillOptions] = useState<PickerOption[]>([]);
  const [subagentOptions, setSubagentOptions] = useState<PickerOption[]>([]);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pickerRevision, setPickerRevision] = useState(0);
  // The capability registries are `member`-gated server-side (`withMemberAuth`),
  // so a guest's picker requests are guaranteed 403s — the same predicate
  // decides here whether to ask at all. Agents stay: every tier may list them.
  const viewer = useViewer();
  const mayReadRegistries = viewer !== null && tierAtLeast(viewer.tier, "member");

  useEffect(() => {
    // Wait until the viewer is known rather than firing requests that are
    // refused for a guest and redundant for everyone else once re-run.
    if (viewer === null) {
      return;
    }
    let cancelled = false;
    const none: never[] = [];
    void Promise.allSettled([
      mayReadRegistries ? listMcps() : Promise.resolve(none),
      mayReadRegistries ? listSkills() : Promise.resolve(none),
      listAgents(),
    ]).then(
      ([mcps, skills, agents]) => {
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
        if (agents.status === "fulfilled") {
          setSubagentOptions(agents.value
            .filter((p) => p.configured && p.name !== agentName)
            .map((p) => ({ value: p.name, description: p.description })));
        }
        const failed = [
          ...(mcps.status === "rejected" ? [t("bindings.mcpServers")] : []),
          ...(skills.status === "rejected" ? [t("configuration.skills")] : []),
          ...(agents.status === "rejected" ? [t("bindings.subagents")] : []),
        ];
        setPickerError(failed.length > 0
          ? t("configuration.pickerLoadFailed", { items: failed.join(", ") })
          : null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [agentName, viewer, mayReadRegistries, pickerRevision, t]);
  const [schemaHelpOpen, setSchemaHelpOpen] = useState(false);

  const selectedModel = models.find((m) => m.id === value.model);
  const fallbackModelConfig = models.find((m) => m.id === value.fallbackModel);
  const selectedImageModel = imageModels.find((m) => m.id === value.parameters.imageModel);
  const supportsReasoning = selectedModel?.capabilities.reasoning ?? true;
  const supportsStructured = selectedModel?.capabilities.structuredOutput ?? true;

  function patch(next: Partial<AgentConfigurationInput>) {
    onChange({ ...value, ...next });
  }
  function patchParams(next: Partial<AgentParameters>) {
    onChange({ ...value, parameters: { ...value.parameters, ...next } });
  }

  return (
    <Stack gap="md">
      {models.length > 0 ? (
        <ModelSelect
          label={t("configuration.model")}
          value={value.model}
          onChange={(model) => patch({ model: model ?? "" })}
          placeholder={t("configuration.selectModel")}
          searchable
          models={models}
          leading={
            // A stored model unavailable for new selection stays present so an
            // Agent can be saved without silently losing it.
            value.model && !selectedModel ? [{ value: value.model, label: value.model }] : []
          }
          error={
            value.model && !selectedModel
              ? t("configuration.modelUnlisted")
              : undefined
          }
        />
      ) : (
        <TextInput
          label={t("configuration.model")}
          value={value.model}
          onChange={(e) => patch({ model: e.currentTarget.value })}
          placeholder="openai/gpt-5-mini"
        />
      )}

      {/* Fallback applies to retryable model failures before the first output. */}
      {(models.length > 0 ? (
          <ModelSelect
            label={t("configuration.fallbackModel")}
            value={value.fallbackModel ?? null}
            onChange={(fallbackModel) => patch({ fallbackModel: fallbackModel ?? undefined })}
            placeholder={t("configuration.none")}
            clearable
            searchable
            models={models}
            leading={
              value.fallbackModel && !fallbackModelConfig
                ? [{ value: value.fallbackModel, label: value.fallbackModel }]
                : []
            }
          />
        ) : (
          <TextInput
            label={t("configuration.fallbackModel")}
            value={value.fallbackModel ?? ""}
            onChange={(e) => patch({ fallbackModel: e.currentTarget.value || undefined })}
          />
        ))}

      <Textarea
        label={t("configuration.systemPrompt")}
        value={value.systemPrompt}
        onChange={(e) => patch({ systemPrompt: e.currentTarget.value })}
        placeholder={t("configuration.systemPromptPlaceholder")}
        autosize
        minRows={8}
        maxRows={30}
        styles={monoInput}
      />
      <ModelRoutingEditor value={value.parameters.modelRouting}
        onChange={(modelRouting) => patchParams({ modelRouting })} />

      <Divider label={t("configuration.group.response")} labelPosition="left" />
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
        <NumberField
          label={t("configuration.temperature")}
          value={value.parameters.temperature}
          onChange={(temperature) => patchParams({ temperature })}
          step={0.1}
          min={0}
          max={2}
          placeholder={t("configuration.defaultPlaceholder")}
        />
        <NumberField
          label={t("configuration.maxTokens")}
          value={value.parameters.maxTokens}
          onChange={(maxTokens) => patchParams({ maxTokens })}
          step={1}
          min={1}
          placeholder={t("configuration.defaultPlaceholder")}
        />
        <NumberField
          label={t("configuration.presencePenalty")}
          value={value.parameters.presencePenalty}
          onChange={(presencePenalty) => patchParams({ presencePenalty })}
          step={0.1}
          min={PRESENCE_PENALTY_RANGE.min}
          max={PRESENCE_PENALTY_RANGE.max}
          placeholder={t("configuration.defaultPlaceholder")}
        />
      </SimpleGrid>

      {supportsReasoning && (
        <Select
          label={t("configuration.reasoningEffort")}
          value={value.parameters.reasoningEffort ?? ""}
          onChange={(effort) =>
            patchParams({
              reasoningEffort: (effort || undefined) as AgentParameters["reasoningEffort"],
            })
          }
          allowDeselect={false}
          data={[
            { value: "", label: t("configuration.default") },
            { value: "low", label: "low" },
            { value: "medium", label: "medium" },
            { value: "high", label: "high" },
          ]}
        />
      )}

      {/*
        Stays visible on a stored `true` even where the model has no reasoning,
        unlike the effort select above it: saving is *rejected* for that pair, so
        hiding the control would leave an author unable to save anything at all.
      */}
      {(supportsReasoning || value.parameters.reasoningTrace) && (
        <Stack gap={4}>
          <Checkbox
            label={t("configuration.reasoningTrace")}
            description={t("configuration.reasoningTraceHint")}
            checked={value.parameters.reasoningTrace ?? false}
            onChange={(e) =>
              patchParams({ reasoningTrace: e.currentTarget.checked ? true : undefined })
            }
          />
          {/* The same constraint /models badges, said where it costs something:
              this model refuses to think while it can call tools, so an agent
              run records its final turn and nothing before it. */}
          {value.parameters.reasoningTrace === true &&
            selectedModel?.capabilities.reasoningWithTools === false && (
              <Text fz="xs" c="yellow.7">
                {t("models.reasoningNoTools")}
              </Text>
            )}
        </Stack>
      )}

      <NumberField
        label={t("configuration.maxTurns")}
        value={value.maxTurn}
        onChange={(maxTurn) => patch({ maxTurn })}
        step={1}
        min={1}
        placeholder="50"
      />

      <Divider label={t("configuration.group.policy")} labelPosition="left" />
      <Checkbox
        label={t("configuration.piiFiltering")}
        description={t("configuration.piiHint")}
        checked={value.parameters.piiFiltering}
        onChange={(e) => patchParams({ piiFiltering: e.currentTarget.checked })}
      />

      <RuntimePolicyEditor value={value.parameters.policy} onChange={(policy) => patchParams({ policy })} />

      <Checkbox
        label={t("configuration.callerContext")}
        description={t("configuration.callerHint")}
        checked={value.parameters.callerContext ?? false}
        onChange={(e) => patchParams({ callerContext: e.currentTarget.checked })}
      />

      {(supportsStructured || value.parameters.structuredOutput || schemaError !== null) && (
        <Stack gap="xs">
          <Group gap={6} wrap="nowrap">
            <Checkbox
              label={t("configuration.structuredOutput")}
              checked={value.parameters.structuredOutput ?? false}
              onChange={(e) => patchParams({ structuredOutput: e.currentTarget.checked })}
            />
            <ActionIcon
              size="sm"
              aria-label={t("configuration.aboutStructuredOutput")}
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

      <Divider label={t("configuration.group.builtins")} labelPosition="left" />
      <Stack gap="xs">
        <Checkbox
          label={t("configuration.imageTools")}
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
          {t("configuration.imageToolsHint")}
        </Text>
        {value.parameters.imageGeneration && (
          <ModelSelect
            label={t("configuration.imageModel")}
            value={value.parameters.imageModel ?? ""}
            onChange={(imageModel) => patchParams({ imageModel: imageModel || undefined })}
            allowDeselect={false}
            models={imageModels}
            leading={
              [
                { value: "", label: t("configuration.default") },
                ...(value.parameters.imageModel && !selectedImageModel
                  ? [{ value: value.parameters.imageModel, label: value.parameters.imageModel }]
                  : []),
              ]
            }
          />
        )}
      </Stack>

      <Checkbox label={t("audio.enableTools")} description={t("audio.enableToolsHint")}
      checked={value.parameters.audioProcessing ?? false}
      onChange={(e) => patchParams({ audioProcessing: e.currentTarget.checked ? true : undefined })} />
      <Checkbox label={t("workspace.enableTools")} description={t("workspace.enableToolsHint")}
      checked={value.parameters.workspaceTools ?? false}
      onChange={(e) => patchParams({ workspaceTools: e.currentTarget.checked ? true : undefined })} />
      <Stack gap="xs">
        <Checkbox
          label={t("configuration.fetchUrl")}
          checked={value.parameters.urlFetch ?? false}
          onChange={(e) => patchParams({ urlFetch: e.currentTarget.checked ? true : undefined })}
        />
        <Text fz="xs" c="dimmed">
          {t("configuration.fetchUrlHint")}
        </Text>
      </Stack>

      <Stack gap="xs">
        <Checkbox
          label={t("configuration.slackWorkspace")}
          checked={value.parameters.slackWorkspace ?? false}
          onChange={(e) =>
            patchParams({ slackWorkspace: e.currentTarget.checked ? true : undefined })
          }
        />
        <Text fz="xs" c="dimmed">
          {t("configuration.slackWorkspaceHint")}
        </Text>
      </Stack>

      <Divider label={t("configuration.group.bindings")} labelPosition="left" />
      <Stack gap="sm">

        {pickerError && (
          <Alert color="yellow" title={pickerError}>
            <Button size="xs" variant="light" onClick={() => setPickerRevision((revision) => revision + 1)}>
              {t("error.retry")}
            </Button>
          </Alert>
        )}

        <McpBindingInput
          agentName={agentName}
          values={value.mcpList}
          onChange={(mcpList) => patch({ mcpList })}
          options={mcpOptions}
          save={save}
        />
        <SearchSelectInput
          label={t("configuration.skills")}
          values={value.skillList}
          onChange={(skillList) => patch({ skillList })}
          options={skillOptions}
          placeholder={t("configuration.searchSkills")}
        />
        <SubagentInput
          values={value.subagentList}
          onChange={(subagentList) => patch({ subagentList })}
          options={subagentOptions}
        />
        <Checkbox
          label={t("configuration.dynamicCapabilities")}
          description={t("configuration.dynamicCapabilitiesHint")}
          checked={value.parameters.dynamicCapabilities ?? false}
          onChange={(e) => patchParams({ dynamicCapabilities: e.currentTarget.checked })}
        />
        <Checkbox
          label={t("configuration.memoryRecall")}
          description={t("configuration.memoryRecallHint")}
          checked={value.parameters.memoryRecall ?? false}
          onChange={(e) =>
            patchParams({ memoryRecall: e.currentTarget.checked ? true : undefined })
          }
        />
        {value.parameters.memoryRecall === true &&
          !bindingsMayOfferRecall(value.mcpList) && (
            // The run's own warning, moved up to where the setting is made:
            // an Agent that recalls with nothing bound to answer would
            // otherwise say so only once a run has started without a memory.
            // Only what the bindings alone rule out — a bound server that
            // turns out not to offer the tool is for the preview to report.
            <Alert color="yellow" variant="light" fz="xs">
              {t("configuration.memoryRecallUnbound")}
            </Alert>
          )}
      </Stack>
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
  const t = useT();
  return (
    <Modal opened={opened} onClose={onClose} title={t("configuration.structuredOutputTitle")} size="lg">
      <Stack gap="sm">
        <Text fz="sm" lh={1.6}>
          {t("structured.intro1")}
          <Code>response_format: json_schema</Code>
          {t("structured.intro2")}
        </Text>
        <List spacing={4} fz="sm">
          <List.Item>
            {t("structured.root1")}
            <Code>object</Code>
            {t("structured.root2")}
            <Code>required</Code>
            {t("structured.root3")}
            <Code>additionalProperties: false</Code>
            {t("structured.root4")}
          </List.Item>
          <List.Item>
            {t("structured.description1")}
            <Code>description</Code>
            {t("structured.description2")}
          </List.Item>
          <List.Item>
            {t("structured.empty1")}
            <Code>response_format</Code>
            {t("structured.empty2")}
          </List.Item>
        </List>
        <Group justify="space-between" gap="xs">
          <Text fz="xs" fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: "0.05em" }}>
            {t("structured.sampleSchema")}
          </Text>
          <CopyButton text={SAMPLE_SCHEMA} />
        </Group>
        <CodeBlock language="json" code={SAMPLE_SCHEMA} />
        <Text fz="xs" fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: "0.05em" }}>
          {t("structured.whatReturns")}
        </Text>
        <CodeBlock language="json" code={SAMPLE_REPLY} />
      </Stack>
    </Modal>
  );
}
