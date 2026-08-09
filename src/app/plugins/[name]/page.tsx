"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Card,
  Group,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { CardList } from "@/app/_components/CardGrid";
import { MCP_RUNTIME_COLOR } from "@/app/_components/badgeColors";
import { listSkills, type SkillSummary } from "@/app/skills/api";
import { listMcps, type McpServer } from "@/app/tools/api";
import { getPlugin, type Plugin } from "../api";

export default function PluginDetailPage() {
  const params = useParams<{ name: string }>();
  const name = params.name;

  const [plugin, setPlugin] = useState<Plugin | null>(null);
  const [skills, setSkills] = useState<Map<string, SkillSummary>>(new Map());
  const [servers, setServers] = useState<Map<string, McpServer>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [nextPlugin, allSkills, allServers] = await Promise.all([
          getPlugin(name),
          listSkills(),
          listMcps(),
        ]);
        if (cancelled) {
          return;
        }
        setPlugin(nextPlugin);
        setSkills(new Map(allSkills.map((skill) => [skill.name, skill])));
        setServers(new Map(allServers.map((server) => [server.name, server])));
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load plugin");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [name]);

  if (loading) {
    return (
      <Text fz="sm" c="dimmed">
        Loading…
      </Text>
    );
  }

  if (error || !plugin) {
    return (
      <Stack gap="md">
        <BackLink />
        <Alert color="red" variant="light">
          {error ?? "Plugin not found"}
        </Alert>
      </Stack>
    );
  }

  const repoUrl = `https://github.com/${plugin.repo}`;
  const treeUrl = `${repoUrl}/tree/${plugin.commitSha}${plugin.rootPath ? `/${plugin.rootPath}` : ""}`;

  return (
    <Stack gap="lg">
      <BackLink />

      <div>
        <Group gap="xs" wrap="nowrap">
          <Title order={1} fz="h2">
            {plugin.name}
          </Title>
          {plugin.version && (
            <Badge size="sm" variant="light">
              v{plugin.version}
            </Badge>
          )}
        </Group>
        {plugin.description && (
          <Text fz="sm" c="dimmed" mt={4} maw={620}>
            {plugin.description}
          </Text>
        )}
        <Text fz="xs" c="dimmed" mt={6}>
          <Anchor href={treeUrl} target="_blank" fz="xs">
            {plugin.repo}
            {plugin.rootPath ? `/${plugin.rootPath}` : ""}
          </Anchor>
          {" · "}
          <Anchor href={`${repoUrl}/commit/${plugin.commitSha}`} target="_blank" fz="xs">
            {plugin.commitSha.slice(0, 7)}
          </Anchor>
          {" · synced "}
          {new Date(plugin.syncedAt).toLocaleString()}
        </Text>
      </div>

      <ComponentSection
        title={`Skills (${plugin.skills.length})`}
        names={plugin.skills}
        emptyText="This plugin declares no skills."
        render={(componentName) => {
          const skill = skills.get(componentName);
          return skill ? (
            <Card key={componentName} component={Link} href={`/skills/${componentName}`} h="100%">
              <Text fw={500}>{componentName}</Text>
              <Text fz="sm" c="dimmed" mt={4} lineClamp={2}>
                {skill.description}
              </Text>
              {skill.files > 0 && (
                <Text fz="xs" c="dimmed" mt={6}>
                  {skill.files} attachment{skill.files === 1 ? "" : "s"}
                </Text>
              )}
            </Card>
          ) : (
            <MissingCard key={componentName} name={componentName} />
          );
        }}
      />

      <ComponentSection
        title={`MCP servers (${plugin.mcpServers.length})`}
        names={plugin.mcpServers}
        emptyText="This plugin declares no MCP servers."
        render={(componentName) => {
          const server = servers.get(componentName);
          return server ? (
            <Card key={componentName} component={Link} href={`/tools/${componentName}`} h="100%">
              <Group gap="xs" wrap="nowrap">
                <Text fw={500} truncate>
                  {componentName}
                </Text>
                {server.runtime === "managed" && (
                  <Badge color={MCP_RUNTIME_COLOR.managed}>managed</Badge>
                )}
              </Group>
              <Text fz="sm" c="dimmed" mt={4} lineClamp={2}>
                {server.description}
              </Text>
              <Text fz="xs" c="dimmed" mt={6} truncate>
                {server.url}
              </Text>
            </Card>
          ) : (
            <MissingCard key={componentName} name={componentName} />
          );
        }}
      />
    </Stack>
  );
}

function ComponentSection({
  title,
  names,
  emptyText,
  render,
}: {
  title: string;
  names: string[];
  emptyText: string;
  render: (name: string) => React.ReactNode;
}) {
  return (
    <section>
      <Text fz="sm" fw={500} c="dimmed" mb="xs">
        {title}
      </Text>
      {names.length === 0 ? (
        <Text fz="sm" c="dimmed">
          {emptyText}
        </Text>
      ) : (
        <CardList>{names.map(render)}</CardList>
      )}
    </section>
  );
}

/** Declared by the plugin but absent from the registry — skipped on sync. */
function MissingCard({ name }: { name: string }) {
  return (
    <Card h="100%" opacity={0.6}>
      <Text fw={500} c="dimmed">
        {name}
      </Text>
      <Text fz="xs" c="dimmed" mt={4}>
        Declared by the plugin but not in the registry — see the last sync report.
      </Text>
    </Card>
  );
}

function BackLink() {
  return (
    <Anchor component={Link} href="/plugins" fz="sm" c="dimmed">
      ← Back to plugins
    </Anchor>
  );
}
