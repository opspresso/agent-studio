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
    try {
      const [entry, connections] = await Promise.all([
        getMcp(serverName),
        listMcpConnections(projectName),
      ]);
      const found = connections.find((c) => c.serverName === serverName);
      setServer(entry);
      setConnection(found);
      setClientId(found?.clientId ?? "");
      // The stored secret is shown masked, like every other secret in this
      // console. Echoing the mask back on save keeps what is stored; typing over
      // it replaces it.
      setClientSecret(found?.clientSecret ?? "");
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoaded(true);
    }
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
    return <p className="text-xs text-neutral-500">Loading…</p>;
  }
  if (!server?.auth) {
    return (
      <p className="text-xs text-neutral-500">
        This server does not require authorization. Whatever credentials it needs come from the
        registry entry&apos;s own headers, plus any override above.
      </p>
    );
  }

  const status = connection?.status ?? "needs_auth";
  const canRegister = Boolean(server.auth.registrationEndpoint);
  const needsManualClient = !canRegister && !connection?.clientId;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-xs text-neutral-500">{server.auth.resource}</p>
        <span className={`text-xs ${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</span>
      </div>

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

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
            placeholder="Client secret"
            className="rounded-md border border-neutral-300 bg-transparent px-3 py-2 font-mono text-sm dark:border-neutral-700"
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
            onClick={() =>
              run(async () => {
                await saveMcpClientCredentials(projectName, serverName, {
                  clientId: clientId.trim(),
                  clientSecret: clientSecret || undefined,
                });
              })
            }
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Save credentials
          </button>
        )}
        <button
          type="button"
          disabled={busy || needsManualClient}
          onClick={() =>
            run(async () => {
              const url = await beginMcpAuthorization(projectName, serverName);
              // A popup rather than a redirect: the editor keeps its unsaved
              // state, and the callback page reports back to this window.
              window.open(url, "mcp-oauth", "width=600,height=760");
            })
          }
          className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-strong disabled:opacity-50"
        >
          {status === "connected" ? "Reauthorize" : "Connect"}
        </button>
        {connection && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(async () => disconnectMcp(projectName, serverName))}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-neutral-700 dark:text-red-400 dark:hover:bg-red-950/30"
          >
            Disconnect
          </button>
        )}
      </div>
    </div>
  );
}
