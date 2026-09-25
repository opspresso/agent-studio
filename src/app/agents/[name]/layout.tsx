"use client";

import { AgentWorkspaceContext } from "./_components/AgentWorkspaceContext";
import { useParams, usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import {
  IconAdjustments,
  IconApi,
  IconChartBar,
  IconPlayerPlay,
  IconPhoto,
  IconPlugConnected,
  IconRoute,
  IconSparkles,
} from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";
import { OwnerLine } from "@/app/_components/OwnerLine";
import { getAgent, type SanitizedAgent } from "../lib/api";
import { onConfigurationChange } from "../lib/configurationEvents";
import { AgentAudioContext } from "./_components/AgentAudioContext";
import { canEditAgent, useViewer } from "@/app/_lib/useViewer";
import { tierMayCreateAgents } from "@/domain/member/tiers";
import { CloneAgentButton } from "./_components/CloneAgentButton";
import { PageHeader } from "@/app/_components/PageHeader";
import { PageTabs } from "@/app/_components/PageTabs";
import { BackLink } from "@/app/_components/BackLink";
import { LoadingText } from "@/app/_components/PageState";

export default function AgentLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ name: string }>();
  const pathname = usePathname();
  const name = params.name;
  const base = `/agents/${name}`;

  // One source for "who is looking at this": `canEditAgent` below reads the
  // same viewer, and a second hook answering it is a second round trip and a
  // second thing to keep in step.
  const viewer = useViewer();
  const t = useT();
  const [agentState, setAgentState] = useState<{ name: string; agent: SanitizedAgent | null; error: string | null } | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const currentState = agentState?.name === name ? agentState : null;
  const currentAgent = currentState?.agent ?? null;
  const ownerEmail = currentAgent?.ownerEmail ?? null;

  useEffect(() => {
    let cancelled = false;
    let sequence = 0;
    const reload = () => {
      const request = ++sequence;
      void getAgent(name).then((agent) => {
        if (!cancelled && request === sequence) setAgentState({ name, agent, error: null });
      }).catch((error) => {
        if (!cancelled && request === sequence) setAgentState({ name, agent: null,
          error: error instanceof Error ? error.message : "Agent could not be loaded" });
      });
    };
    reload();
    const unsubscribe = onConfigurationChange(name, reload);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [name, retryKey]);

  if (!currentState) {
    return <Stack key={name} gap="lg">
      <BackLink href="/agents" label={t("nav.agents")} />
      <LoadingText />
    </Stack>;
  }

  const canManage = canEditAgent(viewer, ownerEmail);
  const tabs = [
    { href: base, label: t("agent.tab.playground"), Icon: IconPlayerPlay },
    { href: `${base}/usage`, label: t("agent.tab.usage"), Icon: IconChartBar },
    ...(ownerEmail && viewer?.email === ownerEmail && currentAgent?.audioToolsEnabled ? [{ href: `${base}/audio`, label: t("audio.title"), Icon: IconSparkles }] : []),
    ...(canManage && currentAgent?.workspaceToolsEnabled ? [{ href: `${base}/workspace`, label: t("workspace.toolsTitle"), Icon: IconSparkles }] : []),
    // Gated like Traces: these hold other people's runtime output, and the
    // delete here is the only way a Slack or trigger run's artifact is removed.
    ...(canManage
      ? [{ href: `${base}/artifacts`, label: t("agent.tab.artifacts"), Icon: IconPhoto }]
      : []),
    ...(canManage
      ? [{ href: `${base}/traces`, label: t("agent.tab.traces"), Icon: IconRoute }]
      : []),
    { href: `${base}/api-reference`, label: t("agent.tab.apiReference"), Icon: IconApi },
    // How other systems reach the agent — bots and the API token. Owner
    // gated like Settings, which is where these lived until the bots outgrew it.
    ...(canManage
      ? [{ href: `${base}/integrations`, label: t("agent.tab.integrations"), Icon: IconPlugConnected }]
      : []),
    ...(canManage
      ? [{ href: `${base}/settings`, label: t("agent.tab.settings"), Icon: IconAdjustments }]
      : []),
  ];

  return (
    // Param-only navigation can reuse this client layout. Remount its children
    // so a draft or pending response from one Agent cannot enter another.
    <Stack key={name} gap="lg">
      <BackLink href="/agents" label={t("nav.agents")} />
      <PageHeader title={currentAgent?.displayName || name} Icon={IconSparkles}
        details={<Text fz="xs" ff="monospace" c="dimmed">{name}</Text>}>
        {ownerEmail && <OwnerLine ownerEmail={ownerEmail} isMine={viewer?.email === ownerEmail} prefix={t("agent.ownedBy")} />}
        {viewer !== null && tierMayCreateAgents(viewer.tier) && <CloneAgentButton sourceName={name} />}
      </PageHeader>
      {currentState?.error && <Alert color="red"><Group justify="space-between" gap="sm">
        <Text size="sm">{currentState.error}</Text>
        <Button size="xs" variant="light" onClick={() => setRetryKey(key => key + 1)}>{t("error.retry")}</Button>
      </Group></Alert>}
      <PageTabs value={pathname} items={tabs} label={t("agent.badge")} />

      <AgentAudioContext.Provider value={currentState ? { enabled: currentAgent?.audioToolsEnabled, error: currentState.error ?? undefined } : {}}>
        <AgentWorkspaceContext.Provider value={currentState ? { enabled: currentAgent?.workspaceToolsEnabled, error: currentState.error ?? undefined } : {}}>
          {children}
        </AgentWorkspaceContext.Provider>
      </AgentAudioContext.Provider>
    </Stack>
  );
}
