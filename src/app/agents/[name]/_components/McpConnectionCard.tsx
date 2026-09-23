"use client";

/**
 * OAuth connections belong to the Project and save independently of Agent settings.
 * Token rotation does not edit the current model, tools or prompt configuration.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  beginMcpAuthorization,
  disconnectMcp,
  listMcpConnections,
  type McpConnectionView,
} from "../../lib/api";
import { getMcp, type McpServer } from "@/app/tools/api";
import { Button, Group, Stack, Text } from "@mantine/core";
import type { MessageKey } from "@/app/_i18n/messages/en";
import { useLocale, useT } from "@/app/_i18n/provider";
import { formatDateTime } from "@/shared/date";
import { createLatestOnly } from "@/app/_lib/latestOnly";

const STATUS_LABEL: Record<McpConnectionView["status"], MessageKey> = {
  connected: "mcpConn.connected",
  needs_auth: "mcpConn.needsAuth",
  needs_reauth: "mcpConn.needsReauth",
};

const STATUS_COLOR: Record<McpConnectionView["status"], string> = {
  connected: "teal",
  needs_auth: "dimmed",
  needs_reauth: "orange",
};

interface AuthorizationPopup {
  location: { href: string };
  closed: boolean;
  close(): void;
}

/** Open during the click; waiting for a network response can exhaust popup activation. */
export async function openMcpAuthorizationPopup(
  authorize: () => Promise<string>,
  openWindow: (url: string, target: string, features: string) => AuthorizationPopup | null,
): Promise<void> {
  const popup = openWindow("about:blank", "mcp-oauth", "width=600,height=760");
  if (!popup) {
    throw new Error("Browser blocked the authorization popup");
  }
  try {
    const url = await authorize();
    if (popup.closed) {
      throw new Error("Authorization popup was closed");
    }
    popup.location.href = url;
  } catch (error) {
    popup.close();
    throw error;
  }
}

export function McpConnectionCard({
  projectName,
  serverName,
  onConnectionChanged,
}: {
  projectName: string;
  serverName: string;
  /**
   * Called whenever the project's credentials for this server change — an
   * authorization finishing, credentials saved, a disconnect. What the server
   * offers depends on them, so anything showing that has to be told; the card
   * cannot know who is listening, which is why this is a signal rather than a
   * refresh of something it owns.
   */
  onConnectionChanged?: () => void;
}) {
  const [server, setServer] = useState<McpServer | null>(null);
  const [connection, setConnection] = useState<McpConnectionView | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = useT();
  const locale = useLocale();
  // Held in a ref so the listener below does not depend on the callback's
  // identity: callers pass an inline arrow, and re-registering the popup
  // listener every render opens a window where the message lands on nothing.
  const changed = useRef(onConnectionChanged);
  changed.current = onConnectionChanged;
  const latestOnly = useRef(createLatestOnly()).current;

  const refresh = useCallback(async () => {
    const isCurrent = latestOnly();
    // Settled independently on purpose. Only the registry entry can say whether
    // this server needs authorization at all, so a failure to read the project's
    // *connections* — which is what a non-owner gets — must never be able to
    // leave the card claiming the server needs none.
    const [entry, connections] = await Promise.allSettled([
      getMcp(serverName),
      listMcpConnections(projectName),
    ]);
    if (isCurrent() && entry.status === "fulfilled") {
      setServer(entry.value);
    }
    if (isCurrent() && connections.status === "fulfilled") {
      const found = connections.value.find((c) => c.serverName === serverName);
      setConnection(found);
    }
    const failure = [entry, connections].find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (!isCurrent()) {
      return;
    }
    if (failure) {
      const reason: unknown = failure.reason;
      setError(reason instanceof Error ? reason.message : String(reason));
    } else {
      setError(null);
    }
    setLoaded(true);
  }, [latestOnly, projectName, serverName]);

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
          changed.current?.();
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

  /**
   * `changesCredentials` is false for the Connect button, which only opens the
   * popup — the authorization finishes later, and the callback above is what
   * says so. Signalling here instead would reload a tool list against
   * credentials that have not changed yet, and on *Reauthorize* would replace a
   * working list with a failure while the reader is still in the popup.
   */
  async function run(action: () => Promise<void>, changesCredentials = false) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
      if (changesCredentials) {
        changed.current?.();
      }
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) {
    return (
      <Text fz="xs" c="dimmed">
        {t("common.loading")}
      </Text>
    );
  }
  if (!server) {
    // Nothing was read about the server, so nothing may be claimed about it.
    return (
      <Text fz="xs" c="red">
        {error ?? t("mcpConn.readFailed")}
      </Text>
    );
  }
  if (!server.auth) {
    return (
      <Text fz="xs" c="dimmed">
        {t("mcpConn.noAuthNeeded")}
      </Text>
    );
  }

  const status = connection?.status ?? "needs_auth";
  const automaticClient = Boolean(
    server.auth.registrationEndpoint || server.auth.clientIdMetadataDocumentSupported,
  );
  const missingClient = !server.auth.clientId && !automaticClient;
  return (
    <Stack gap="sm">
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Text ff="monospace" fz="xs" c="dimmed" truncate>
          {server.auth.resource}
        </Text>
        <Text fz="xs" c={STATUS_COLOR[status]} style={{ flexShrink: 0 }}>
          {t(STATUS_LABEL[status])}
        </Text>
      </Group>

      {error && (
        <Text fz="xs" c="red">
          {error}
        </Text>
      )}

      {missingClient && (
        <Text fz="xs" c="dimmed">
          {t("mcpConn.noClientDocument")}
        </Text>
      )}

      {connection?.connectedAt && (
        // Wrapped because a granted scope list is unbounded and comes from the
        // provider: one long token with nothing to break on must fold rather
        // than push the dialog off the viewport.
        <Text fz="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
          {t("mcpConn.authorizedBy", {
            // Optional on the view; an absent one renders as it did before —
            // the sentence without a name, rather than the word "undefined".
            who: connection.connectedBy ?? "",
            when: formatDateTime(connection.connectedAt, locale),
          })}
          {connection.scopes.length > 0 ? ` · ${connection.scopes.join(", ")}` : ""}
        </Text>
      )}

      <Group gap="xs" wrap="wrap">
        <Button
          disabled={busy || missingClient}
          onClick={() =>
            run(async () => {
              // A popup rather than a redirect: the editor keeps its unsaved
              // state, and the callback page reports back to this window.
              await openMcpAuthorizationPopup(
                () => beginMcpAuthorization(projectName, serverName),
                (url, target, features) => window.open(url, target, features),
              );
            })
          }
        >
          {status === "connected" ? t("mcpConn.reauthorize") : t("mcpConn.connect")}
        </Button>
        {connection && (
          <Button
            variant="default"
            color="red"
            disabled={busy}
            onClick={() => run(async () => disconnectMcp(projectName, serverName), true)}
          >
            {t("mcpConn.disconnect")}
          </Button>
        )}
      </Group>
    </Stack>
  );
}
