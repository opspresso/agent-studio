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
import { useT } from "@/app/_i18n/provider";
import { CodeBlock } from "@/app/_components/CodeBlock";
import { CopyButton } from "@/app/_components/CopyButton";
import {
  modelSelectData,
  modelSummary,
  renderModelOption,
  selectOnFocus,
} from "@/app/_components/modelOptions";
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
import { bindingsMayOfferRecall } from "@/domain/project/memoryRecall";
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
  const t = useT();
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
  const fallbackModelConfig = models.find((m) => m.id === value.fallbackModel);
  const selectedImageModel = imageModels.find((m) => m.id === value.parameters.imageModel);
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
      setSchemaError(t("version.invalidJson"));
    }
  }

  return (
    <Stack gap="md">
      {models.length > 0 ? (
        <Select
          label={t("version.model")}
          value={value.model}
          onChange={(model) => patch({ model: model ?? "" })}
          placeholder={t("version.selectModel")}
          searchable
          data={modelSelectData(
            models,
            // A stored model missing from the catalog stays selectable so a
            // version can be saved without silently losing it.
            value.model && !selectedModel ? [{ value: value.model, label: value.model }] : [],
          )}
          renderOption={renderModelOption(models)}
          {...selectOnFocus}
          description={selectedModel ? modelSummary(selectedModel) : undefined}
          error={
            value.model && !selectedModel
              ? t("version.modelUnlisted")
              : undefined
          }
        />
      ) : (
        <TextInput
          label={t("version.model")}
          value={value.model}
          onChange={(e) => patch({ model: e.currentTarget.value })}
          placeholder="openai/gpt-5-mini"
        />
      )}

      {/* Retried on a completion failure — a path an image run does not have. */}
      {projectType !== "image" &&
        (models.length > 0 ? (
          <Select
            label={t("version.fallbackModel")}
            value={value.fallbackModel ?? null}
            onChange={(fallbackModel) => patch({ fallbackModel: fallbackModel ?? undefined })}
            placeholder={t("version.none")}
            clearable
            searchable
            data={modelSelectData(models)}
            renderOption={renderModelOption(models)}
            {...selectOnFocus}
            description={fallbackModelConfig ? modelSummary(fallbackModelConfig) : undefined}
          />
        ) : (
          <TextInput
            label={t("version.fallbackModel")}
            value={value.fallbackModel ?? ""}
            onChange={(e) => patch({ fallbackModel: e.currentTarget.value || undefined })}
          />
        ))}

      <Textarea
        label={t("version.systemPrompt")}
        value={value.systemPrompt}
        onChange={(e) => patch({ systemPrompt: e.currentTarget.value })}
        placeholder={
          projectType === "image"
            ? t("version.systemPromptImagePlaceholder")
            : t("version.systemPromptPlaceholder")
        }
        description={
          projectType === "image" ? t("version.systemPromptImageHint") : undefined
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
            label={t("version.userPromptTemplate")}
            value={value.userPromptTemplate}
            onChange={(e) => patch({ userPromptTemplate: e.currentTarget.value })}
            placeholder={t("version.userPromptPlaceholder")}
            autosize
            minRows={4}
            maxRows={20}
            styles={monoInput}
          />
          <Group justify="space-between" gap="xs" mt={4} wrap="nowrap">
            <Text fz="xs" c="dimmed">
              {projectType === "agent"
                ? t("version.userPromptAgentHint")
                : t("version.userPromptHint")}
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
            label={t("version.temperature")}
            value={value.parameters.temperature}
            onChange={(temperature) => patchParams({ temperature })}
            step={0.1}
            min={0}
            max={2}
            placeholder={t("version.defaultPlaceholder")}
          />
          <NumberField
            label={t("version.maxTokens")}
            value={value.parameters.maxTokens}
            onChange={(maxTokens) => patchParams({ maxTokens })}
            step={1}
            min={1}
            placeholder={t("version.defaultPlaceholder")}
          />
        </SimpleGrid>
      )}

      {projectType !== "image" && supportsReasoning && (
        <Select
          label={t("version.reasoningEffort")}
          value={value.parameters.reasoningEffort ?? ""}
          onChange={(effort) =>
            patchParams({
              reasoningEffort: (effort || undefined) as VersionParameters["reasoningEffort"],
            })
          }
          allowDeselect={false}
          data={[
            { value: "", label: t("version.default") },
            { value: "low", label: "low" },
            { value: "medium", label: "medium" },
            { value: "high", label: "high" },
          ]}
        />
      )}

      {projectType === "agent" && (
        <NumberField
          label={t("version.maxTurns")}
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
          label={t("version.piiFiltering")}
          description={
            projectType === "image" ? t("version.piiImageHint") : t("version.piiHint")
          }
          checked={value.parameters.piiFiltering}
          onChange={(e) => patchParams({ piiFiltering: e.currentTarget.checked })}
        />
      )}

      {(projectType !== "image" || value.parameters.callerContext) && (
        <Checkbox
          label={t("version.callerContext")}
          description={
            projectType === "image" ? t("version.callerImageHint") : t("version.callerHint")
          }
          checked={value.parameters.callerContext ?? false}
          onChange={(e) => patchParams({ callerContext: e.currentTarget.checked })}
        />
      )}

      {projectType !== "image" && supportsStructured && (
        <Stack gap="xs">
          <Group gap={6} wrap="nowrap">
            <Checkbox
              label={t("version.structuredOutput")}
              checked={value.parameters.structuredOutput ?? false}
              onChange={(e) => patchParams({ structuredOutput: e.currentTarget.checked })}
            />
            <ActionIcon
              size="sm"
              aria-label={t("version.aboutStructuredOutput")}
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
            label={t("version.imageTools")}
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
            {t("version.imageToolsHint")}
          </Text>
          {value.parameters.imageGeneration && (
            <Select
              label={t("version.imageModel")}
              value={value.parameters.imageModel ?? ""}
              onChange={(imageModel) => patchParams({ imageModel: imageModel || undefined })}
              allowDeselect={false}
              data={modelSelectData(imageModels, [{ value: "", label: t("version.default") }])}
              renderOption={renderModelOption(imageModels)}
              description={selectedImageModel ? modelSummary(selectedImageModel) : undefined}
            />
          )}
        </Stack>
      )}

      {(runsTools || value.parameters.urlFetch) && (
        <Stack gap="xs">
          <Checkbox
            label={t("version.fetchUrl")}
            checked={value.parameters.urlFetch ?? false}
            onChange={(e) => patchParams({ urlFetch: e.currentTarget.checked ? true : undefined })}
          />
          <Text fz="xs" c="dimmed">
            {t("version.fetchUrlHint")}
          </Text>
        </Stack>
      )}

      {(runsTools || value.parameters.slackWorkspace) && (
        <Stack gap="xs">
          <Checkbox
            label={t("version.slackWorkspace")}
            checked={value.parameters.slackWorkspace ?? false}
            onChange={(e) =>
              patchParams({ slackWorkspace: e.currentTarget.checked ? true : undefined })
            }
          />
          <Text fz="xs" c="dimmed">
            {t("version.slackWorkspaceHint")}
          </Text>
        </Stack>
      )}

      {(runsTools || hasToolBindings) && (
        <Stack gap="sm">
          {!runsTools && (
            <Alert color="yellow" variant="light" fz="xs">
              {projectType === "image"
                ? t("version.bindingsInertImage")
                : t("version.bindingsInertLlm")}
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
            label={t("version.skills")}
            values={value.skillList}
            onChange={(skillList) => patch({ skillList })}
            options={skillOptions}
            placeholder={t("version.searchSkills")}
          />
          <SubagentInput
            values={value.subagentList}
            onChange={(subagentList) => patch({ subagentList })}
            options={subagentOptions}
          />
          {runsTools && (
            <Checkbox
              label={t("version.dynamicCapabilities")}
              description={t("version.dynamicCapabilitiesHint")}
              checked={value.parameters.dynamicCapabilities ?? false}
              onChange={(e) => patchParams({ dynamicCapabilities: e.currentTarget.checked })}
            />
          )}
          {(runsTools || value.parameters.memoryRecall) && (
            <Checkbox
              label={t("version.memoryRecall")}
              description={t("version.memoryRecallHint")}
              checked={value.parameters.memoryRecall ?? false}
              onChange={(e) =>
                patchParams({ memoryRecall: e.currentTarget.checked ? true : undefined })
              }
            />
          )}
          {runsTools &&
            value.parameters.memoryRecall === true &&
            !bindingsMayOfferRecall(value.mcpList) && (
              // The run's own warning, moved up to where the setting is made:
              // a version that recalls with nothing bound to answer would
              // otherwise say so only once a run has started without a memory.
              // Only what the bindings alone rule out — a bound server that
              // turns out not to offer the tool is for the preview to report.
              <Alert color="yellow" variant="light" fz="xs">
                {t("version.memoryRecallUnbound")}
              </Alert>
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
  const t = useT();
  return (
    <Modal opened={opened} onClose={onClose} title={t("version.structuredOutputTitle")} size="lg">
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
