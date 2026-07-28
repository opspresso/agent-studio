"use client";

/**
 * This project's OAuth connection to one shared registry server.
 *
 * Scoped to the project, not the version: every version binding this server
 * uses the same connection, and a token turning over must not read as a version
 * edit. It therefore saves on its own buttons rather than riding the version's
 * Save — which is why the modal it sits in says so.
 */

import { useCallback, useEffect, useState } from "react";
import {
  beginMcpAuthorization,
  disconnectMcp,
  listMcpConnections,
  saveMcpClientCredentials,
  type McpConnectionView,
} from "../../lib/api";
import { getMcp, type McpServer } from "@/app/tools/api";
import { Button, Group, SimpleGrid, Stack, Text, TextInput } from "@mantine/core";
import { monoInput } from "@/app/_components/monoInput";

const STATUS_LABEL: Record<McpConnectionView["status"], string> = {
  connected: "Connected",
  needs_auth: "Not authorized",
  needs_reauth: "Reconnect required",
};

const STATUS_COLOR: Record<McpConnectionView["status"], string> = {
  connected: "teal",
  needs_auth: "dimmed",
  needs_reauth: "orange",
};

export function McpConnectionCard({
  projectName,
  serverName,
}: {
  projectName: string;
  serverName: string;
}) {
  const [server, setServer] = useState<McpServer | null>(null);
  const [connection, setConnection] = useState<McpConnectionView | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const refresh = useCallback(async () => {
    // Settled independently on purpose. Only the registry entry can say whether
    // this server needs authorization at all, so a failure to read the project's
    // *connections* — which is what a non-owner gets — must never be able to
    // leave the card claiming the server needs none.
    const [entry, connections] = await Promise.allSettled([
      getMcp(serverName),
      listMcpConnections(projectName),
    ]);
    if (entry.status === "fulfilled") {
      setServer(entry.value);
    }
    if (connections.status === "fulfilled") {
      const found = connections.value.find((c) => c.serverName === serverName);
      setConnection(found);
      setClientId(found?.clientId ?? "");
      // The stored secret is shown masked, like every other secret in this
      // console. Echoing the mask back on save keeps what is stored, typing over
      // it replaces it, and emptying it clears it.
      setClientSecret(found?.clientSecret ?? "");
    }
    const failure = [entry, connections].find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) {
      const reason: unknown = failure.reason;
      setError(reason instanceof Error ? reason.message : String(reason));
    } else {
      setError(null);
    }
    setLoaded(true);
  }, [projectName, serverName]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The callback runs in a popup and reports back before closing, so the status
  // reflects a finished authorization without the user reloading the page.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || typeof event.data !== "string") {
        return;
      }
      try {
        const outcome = JSON.parse(event.data) as { ok?: boolean; error?: string };
        if (outcome.ok === true) {
          void refresh();
        } else if (outcome.ok === false && outcome.error) {
          setError(outcome.error);
        }
      } catch {
        // Not one of ours.
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [refresh]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) {
    return (
      <Text fz="xs" c="dimmed">
        Loading…
      </Text>
    );
  }
  if (!server) {
    // Nothing was read about the server, so nothing may be claimed about it.
    return (
      <Text fz="xs" c="red">
        {error ?? "Could not read this server's registry entry."}
      </Text>
    );
  }
  if (!server.auth) {
    return (
      <Text fz="xs" c="dimmed">
        This server does not require authorization. Whatever credentials it needs come from the
        registry entry&apos;s own headers, plus any override above.
      </Text>
    );
  }

  const status = connection?.status ?? "needs_auth";
  const canRegister = Boolean(server.auth.registrationEndpoint);
  const needsManualClient = !canRegister && !connection?.clientId;

  return (
    <Stack gap="sm">
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Text ff="monospace" fz="xs" c="dimmed" truncate>
          {server.auth.resource}
        </Text>
        <Text fz="xs" c={STATUS_COLOR[status]} style={{ flexShrink: 0 }}>
          {STATUS_LABEL[status]}
        </Text>
      </Group>

      {error && (
        <Text fz="xs" c="red">
          {error}
        </Text>
      )}

      {needsManualClient && (
        <Text fz="xs" c="dimmed">
          This provider does not offer dynamic registration. Register an app with it, then save its
          client ID and secret here.
        </Text>
      )}

      {!canRegister && (
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
          <TextInput
            value={clientId}
            onChange={(e) => setClientId(e.currentTarget.value)}
            placeholder="Client ID"
          />
          <TextInput
            value={clientSecret}
            onChange={(e) => setClientSecret(e.currentTarget.value)}
            placeholder="Client secret"
            styles={monoInput}
          />
        </SimpleGrid>
      )}

      {connection?.connectedAt && (
        // Wrapped because a granted scope list is unbounded and comes from the
        // provider: one long token with nothing to break on must fold rather
        // than push the dialog off the viewport.
        <Text fz="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
          Authorized by {connection.connectedBy} on{" "}
          {new Date(connection.connectedAt).toLocaleString()}
          {connection.scopes.length > 0 ? ` · ${connection.scopes.join(", ")}` : ""}
        </Text>
      )}

      <Group gap="xs" wrap="wrap">
        {!canRegister && (
          <Button
            variant="default"
            disabled={busy || !clientId.trim()}
            onClick={() =>
              run(async () => {
                await saveMcpClientCredentials(projectName, serverName, {
                  clientId: clientId.trim(),
                  // Sent verbatim, empty included: this box arrives prefilled,
                  // so an empty one means "clear it", not "I typed nothing".
                  clientSecret,
                });
              })
            }
          >
            Save credentials
          </Button>
        )}
        <Button
          disabled={busy || needsManualClient}
          onClick={() =>
            run(async () => {
              const url = await beginMcpAuthorization(projectName, serverName);
              // A popup rather than a redirect: the editor keeps its unsaved
              // state, and the callback page reports back to this window.
              window.open(url, "mcp-oauth", "width=600,height=760");
            })
          }
        >
          {status === "connected" ? "Reauthorize" : "Connect"}
        </Button>
        {connection && (
          <Button
            variant="default"
            color="red"
            disabled={busy}
            onClick={() => run(async () => disconnectMcp(projectName, serverName))}
          >
            Disconnect
          </Button>
        )}
      </Group>
    </Stack>
  );
}
