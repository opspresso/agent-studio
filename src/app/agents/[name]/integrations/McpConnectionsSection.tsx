"use client";

import { useEffect, useState } from "react";
import { Alert, Select, Stack, Text } from "@mantine/core";
import { getConfiguration } from "../../lib/api";
import { listMcps } from "@/app/tools/api";
import { useT } from "@/app/_i18n/provider";
import { canRunAgents, useViewer } from "@/app/_lib/useViewer";
import { CollapsibleSection } from "@/app/_components/CollapsibleSection";
import { LoadingText } from "@/app/_components/PageState";
import { McpConnectionCard } from "../_components/McpConnectionCard";

/** Agent bindings are shared; this section only edits the caller's personal connections. */
export function McpConnectionsSection({ agentName }: { agentName: string }) {
  const t = useT();
  const mayConnect = canRunAgents(useViewer());
  const [servers, setServers] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!mayConnect) return;
    let current = true;
    setServers(null); setError(null);
    void Promise.all([getConfiguration(agentName), listMcps()]).then(([view, entries]) => {
      if (!current) return;
      const bound = new Set(view.configuration?.mcpList.map(binding => binding.name));
      const names = entries.filter(server => server.auth && (bound.has(server.name) || view.configuration?.parameters.dynamicCapabilities)).map(server => server.name);
      setServers(names);
      setSelected(previous => previous && names.includes(previous) ? previous : names[0] ?? null);
    }).catch(error => { if (current) setError(error instanceof Error ? error.message : "MCP connections could not be loaded"); });
    return () => { current = false; };
  }, [agentName, mayConnect]);

  return <CollapsibleSection title={t("mcpConn.personalTitle")} defaultOpen>
    <Stack gap="sm">
      <Text size="sm" c="dimmed">{t("mcpConn.personalDescription")}</Text>
      {!mayConnect ? <Alert>{t("common.memberExecutionRequired")}</Alert> : error ? <Alert color="red">{error}</Alert>
        : !servers ? <LoadingText /> : servers.length === 0 ? <Text size="sm" c="dimmed">{t("mcpConn.noBoundServers")}</Text> : <>
          <Select label={t("mcpConn.server")} value={selected} data={servers} onChange={setSelected} allowDeselect={false} searchable />
          {selected && <McpConnectionCard key={`${agentName}:${selected}`} agentName={agentName} serverName={selected} />}
        </>}
    </Stack>
  </CollapsibleSection>;
}
