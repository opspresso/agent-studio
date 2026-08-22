"use client";

import { Badge, Code, Stack, Text } from "@mantine/core";
import { CollapsibleCode } from "@/app/_components/CollapsibleCode";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { CopyableUrl } from "@/app/_components/CopyableUrl";
import { stateColor } from "@/app/_components/badgeColors";
import { useT } from "@/app/_i18n/provider";

/**
 * How an application embeds this project through AG-UI: the endpoint, what
 * it authenticates with, and the shortest client that talks to it. Nothing
 * is fetched — the address is a function of the name, and whether it answers
 * is a function of the published pointer the page already holds.
 */
export function AguiSection({ projectName, published }: { projectName: string; published: boolean }) {
  const t = useT();
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const url = `${origin}/api/agui/${projectName}`;
  const client = [
    'import { HttpAgent } from "@ag-ui/client";',
    "",
    "const agent = new HttpAgent({",
    `  url: "${url}",`,
    '  headers: { Authorization: "Bearer $PROJECT_API_TOKEN" },',
    "});",
    "",
    "await agent.runAgent({",
    '  tools: [{ name: "showMap", description: "Show a place on the map", parameters: { type: "object", properties: { place: { type: "string" } } } }],',
    "});",
  ].join("\n");

  return (
    <CollapsibleSection
      title={t("pset.agui")}
      badge={
        <Badge color={stateColor(published)} radius="xl">
          {published ? "exposed" : "not published"}
        </Badge>
      }
    >
      <Stack gap="sm">
        <Text fz="xs" c="dimmed" lh={1.6}>
          The published version answers AG-UI runs at this address — an application sends a{" "}
          <Code>RunAgentInput</Code> and reads an event stream. Callers authenticate with the
          project&apos;s API token in <Code>Authorization: Bearer</Code>; the thread id they send is
          the run&apos;s conversation, and any tools they declare are offered to the run and executed
          on their side.
        </Text>
        {!published && (
          <Text fz="sm" c="dimmed">
            Publish a version to expose this project over AG-UI.
          </Text>
        )}
        <CopyableUrl url={url} />
        <CollapsibleCode title="@ag-ui/client" language="javascript" code={client} copyLabel="Copy example" />
      </Stack>
    </CollapsibleSection>
  );
}
