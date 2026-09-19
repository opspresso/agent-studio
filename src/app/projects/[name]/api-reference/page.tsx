"use client";

import { Fragment, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { canEditProject, useViewer } from "@/app/_lib/useViewer";
import { CopyButton } from "@/app/_components/CopyButton";
import { LoadingText } from "@/app/_components/PageState";
import { CodeBlock } from "@/app/_components/CodeBlock";
import { Badge, Card, Code, Group, SegmentedControl, Stack, Table, Text } from "@mantine/core";
import {
  getProject,
  getProjectA2a,
  getProjectSlack,
  getProjectTeams,
  getProjectTelegram,
  listTriggers,
} from "../../lib/api";
import { PROJECT_WEBHOOK_ID } from "@/domain/trigger/types";
import {
  AUTH_LABEL,
  buildApiReference,
  type ApiEndpoint,
  type ApiReferenceContext,
  type CodeExample,
  type FieldSpec,
} from "./endpoints";
import { HTTP_METHOD_COLOR, STREAMING_COLOR } from "@/app/_components/badgeColors";
import { useT } from "@/app/_i18n/provider";

function FieldRows({ fields, depth = 0 }: { fields: FieldSpec[]; depth?: number }) {
  return (
    <>
      {fields.map((field) => (
        <Fragment key={`${depth}-${field.name}`}>
          <Table.Tr style={{ verticalAlign: "top" }}>
            <Table.Td
              ff="monospace"
              style={depth > 0 ? { paddingLeft: depth * 16 } : undefined}
            >
              {depth > 0 && (
                <Text component="span" c="dimmed">
                  └{" "}
                </Text>
              )}
              {field.name}
              {field.required && (
                <Text component="span" c="red" ml={4}>
                  *
                </Text>
              )}
            </Table.Td>
            <Table.Td ff="monospace" c="dimmed">
              {field.type}
            </Table.Td>
            <Table.Td c="dimmed">{field.description}</Table.Td>
          </Table.Tr>
          {field.children && <FieldRows fields={field.children} depth={depth + 1} />}
        </Fragment>
      ))}
    </>
  );
}

function FieldTable({ label, fields }: { label: string; fields: FieldSpec[] }) {
  return (
    <Stack gap={4}>
      <Text fz="xs" fw={500} tt="uppercase" c="dimmed">
        {label}
      </Text>
      <Table.ScrollContainer minWidth={420}>
        <Table fz="xs" verticalSpacing={6} horizontalSpacing={0} withRowBorders>
          <Table.Thead>
            <Table.Tr>
              <Table.Th pr="md">Field</Table.Th>
              <Table.Th pr="md">Type</Table.Th>
              <Table.Th>Description</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            <FieldRows fields={fields} />
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}

function CodeExamples({ examples }: { examples: CodeExample[] }) {
  const [active, setActive] = useState(0);
  const current = examples[active] ?? examples[0];
  if (!current) {
    return null;
  }
  return (
    <Stack gap={4}>
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <SegmentedControl
          size="xs"
          value={String(active)}
          onChange={(value) => setActive(Number(value))}
          data={examples.map((example, index) => ({
            value: String(index),
            label: example.label,
          }))}
        />
        <CopyButton text={current.code} />
      </Group>
      <CodeBlock language={current.language} code={current.code} />
    </Stack>
  );
}

function ResponseExample({ code }: { code: string }) {
  return (
    <Stack gap={4}>
      <Group justify="space-between">
        <Text fz="xs" fw={500} tt="uppercase" c="dimmed">
          Response example
        </Text>
        <CopyButton text={code} />
      </Group>
      <CodeBlock language="json" code={code} />
    </Stack>
  );
}

function EndpointCard({ endpoint }: { endpoint: ApiEndpoint }) {
  const t = useT();
  return (
    <Card>
      <Stack gap="md">
        <Stack gap="xs">
          <Group gap="xs" wrap="wrap">
            <Badge color={HTTP_METHOD_COLOR[endpoint.method]} ff="monospace">
              {endpoint.method}
            </Badge>
            <Code
              title={endpoint.path}
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {endpoint.path}
            </Code>
            {endpoint.streaming && (
              <Badge color={STREAMING_COLOR} radius="xl">
                SSE
              </Badge>
            )}
          </Group>
          <Text fz="sm" fw={500}>
            {endpoint.title}
          </Text>
          <Text fz="xs" c="dimmed" lh={1.6}>
            {endpoint.description}
          </Text>
        </Stack>

        <Group gap="xl" fz="xs" wrap="wrap">
          <Text fz="xs" c="dimmed">
            Auth:{" "}
            <Text component="span" fz="xs" c="var(--mantine-color-text)">
              {AUTH_LABEL[endpoint.auth]}
            </Text>
          </Text>
          {endpoint.errorCodes.length > 0 && (
            <Text fz="xs" c="dimmed">
              Errors:{" "}
              <Text component="span" fz="xs" ff="monospace" c="var(--mantine-color-text)">
                {endpoint.errorCodes.join(" · ")}
              </Text>
            </Text>
          )}
        </Group>

        {endpoint.requestFields && <FieldTable label={t("apiRef.request")} fields={endpoint.requestFields} />}
        <CodeExamples examples={endpoint.codeExamples} />
        {endpoint.responseFields && <FieldTable label={t("apiRef.response")} fields={endpoint.responseFields} />}
        {endpoint.responseExample && <ResponseExample code={endpoint.responseExample} />}
      </Stack>
    </Card>
  );
}

export default function ApiReferencePage() {
  const { name } = useParams<{ name: string }>();
  const viewer = useViewer();
  const [endpoints, setEndpoints] = useState<ApiEndpoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const project = await getProject(name);
        const isOwner = canEditProject(viewer, project.ownerEmail);

        const [a2a, slack, telegram, teams, triggers] = await Promise.all([
          getProjectA2a(name).catch(() => null),
          isOwner ? getProjectSlack(name).catch(() => null) : Promise.resolve(null),
          isOwner ? getProjectTelegram(name).catch(() => null) : Promise.resolve(null),
          isOwner ? getProjectTeams(name).catch(() => null) : Promise.resolve(null),
          // Owner-gated like Slack: the list carries the webhook's masked secret,
          // and a viewer who cannot read the secret cannot call the endpoint.
          isOwner ? listTriggers(name).catch(() => null) : Promise.resolve(null),
        ]);
        const webhook =
          triggers?.triggers.find(
            (trigger) => trigger.triggerId === PROJECT_WEBHOOK_ID && trigger.kind === "webhook",
          ) ?? null;

        const ctx: ApiReferenceContext = {
          projectName: project.name,
          projectType: project.projectType,
          configured: project.configured ?? null,
          origin: typeof window === "undefined" ? "" : window.location.origin,
          a2a: a2a ? { enabled: a2a.enabled, configured: a2a.configured } : null,
          slack: slack ? { configured: slack.configured } : null,
          telegram: telegram ? { configured: telegram.configured } : null,
          teams: teams ? { configured: teams.configured } : null,
          webhook: triggers ? { enabled: webhook?.enabled === true } : null,
        };

        if (!cancelled) {
          setEndpoints(buildApiReference(ctx));
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load API reference");
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [name, viewer]);

  if (error) {
    return (
      <Text fz="sm" c="red">
        {error}
      </Text>
    );
  }
  if (!endpoints) {
    return <LoadingText />;
  }

  return (
    <Stack gap="md">
      <Text fz="sm" c="dimmed">
        Endpoints for calling this project from outside the console. Paths are filled in with the
        project name and its configured version; replace <Code>$PROJECT_API_TOKEN</Code> and other{" "}
        <Code>$…</Code> placeholders with your own credentials. Generate a token under Settings →
        API token.
      </Text>
      {endpoints.length === 0 ? (
        <Text fz="sm" c="dimmed">
          No callable endpoints yet — publish a version to expose this project.
        </Text>
      ) : (
        endpoints.map((endpoint) => <EndpointCard key={endpoint.id} endpoint={endpoint} />)
      )}
    </Stack>
  );
}
