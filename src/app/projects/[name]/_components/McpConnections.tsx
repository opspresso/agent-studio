"use client";

/**
 * A project's OAuth connections to shared registry servers.
 *
 * Lives on the project rather than in the version editor because a connection
 * is per project: every version that binds the server uses the same one, and a
 * token turning over must not look like a version edit.
 */

import { useCallback, useEffect, useState } from "react";
import {
  beginMcpAuthorization,
  disconnectMcp,
  listMcpConnections,
  saveMcpClientCredentials,
  type McpConnectionView,
} from "../../lib/api";
import { listMcps, type McpServer } from "@/app/tools/api";

const STATUS_LABEL: Record<McpConnectionView["status"], string> = {
  connected: "Connected",
  needs_auth: "Not authorized",
  needs_reauth: "Reconnect required",
};

const STATUS_CLASS: Record<McpConnectionView["status"], string> = {
  connected: "text-emerald-600 dark:text-emerald-400",
  needs_auth: "text-neutral-500",
  needs_reauth: "text-amber-600 dark:text-amber-400",
};

export function McpConnections({ projectName }: { projectName: string }) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [connections, setConnections] = useState<McpConnectionView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [allServers, existing] = await Promise.all([listMcps(), listMcpConnections(projectName)]);
      setServers(allServers.filter((server) => server.auth));
      setConnections(existing);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [projectName]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The callback runs in a popup and reports back before closing, so the list
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

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(null);
    }
  }

  if (servers.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        No registry MCP server requires OAuth yet. An admin configures that on the server itself.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {servers.map((server) => {
        const connection = connections.find((c) => c.serverName === server.name);
        const canRegister = Boolean(server.auth?.registrationEndpoint);
        return (
          <ServerRow
            key={server.name}
            server={server}
            connection={connection}
            canRegister={canRegister}
            busy={busy === server.name}
            onSave={(input) =>
              run(server.name, async () => {
                await saveMcpClientCredentials(projectName, server.name, input);
              })
            }
            onAuthorize={() =>
              run(server.name, async () => {
                const url = await beginMcpAuthorization(projectName, server.name);
                // A popup rather than a redirect: the console keeps its unsaved
                // state, and the callback page reports back to this window.
                window.open(url, "mcp-oauth", "width=600,height=760");
              })
            }
            onDisconnect={() =>
              run(server.name, async () => {
                await disconnectMcp(projectName, server.name);
              })
            }
          />
        );
      })}
    </div>
  );
}

function ServerRow({
  server,
  connection,
  canRegister,
  busy,
  onSave,
  onAuthorize,
  onDisconnect,
}: {
  server: McpServer;
  connection?: McpConnectionView;
  canRegister: boolean;
  busy: boolean;
  onSave: (input: { clientId: string; clientSecret?: string }) => void;
  onAuthorize: () => void;
  onDisconnect: () => void;
}) {
  const [clientId, setClientId] = useState(connection?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");

  useEffect(() => {
    setClientId(connection?.clientId ?? "");
  }, [connection?.clientId]);

  const status = connection?.status ?? "needs_auth";
  // With dynamic registration the provider issues the client, so there is
  // nothing for the owner to paste in first.
  const needsManualClient = !canRegister && !connection?.clientId;

  return (
    <div className="space-y-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{server.name}</p>
          <p className="text-xs text-neutral-500">{server.auth?.resource}</p>
        </div>
        <span className={`text-xs ${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</span>
      </div>

      {needsManualClient && (
        <p className="text-xs text-neutral-500">
          This provider does not offer dynamic registration. Register an app with it, then save
          its client ID and secret here.
        </p>
      )}

      {!canRegister && (
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="Client ID"
            className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700"
          />
          <input
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={connection?.hasClientSecret ? "Client secret (unchanged)" : "Client secret"}
            type="password"
            className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700"
          />
        </div>
      )}

      {connection?.connectedAt && (
        <p className="text-xs text-neutral-500">
          Authorized by {connection.connectedBy} on{" "}
          {new Date(connection.connectedAt).toLocaleString()}
          {connection.scopes.length > 0 ? ` · ${connection.scopes.join(", ")}` : ""}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!canRegister && (
          <button
            type="button"
            disabled={busy || !clientId.trim()}
            onClick={() => onSave({ clientId: clientId.trim(), clientSecret: clientSecret || undefined })}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Save credentials
          </button>
        )}
        <button
          type="button"
          disabled={busy || needsManualClient}
          onClick={onAuthorize}
          className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-strong disabled:opacity-50"
        >
          {status === "connected" ? "Reauthorize" : "Connect"}
        </button>
        {connection && (
          <button
            type="button"
            disabled={busy}
            onClick={onDisconnect}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-neutral-700 dark:text-red-400 dark:hover:bg-red-950/30"
          >
            Disconnect
          </button>
        )}
      </div>
    </div>
  );
}
