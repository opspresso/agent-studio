"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  deleteMcp,
  getManagedMcpStatus,
  removeManagedMcp,
  restartManagedMcp,
  updateManagedMcp,
  type ManagedMcpStatus,
  getMcp,
  testMcpConnection,
  discoverMcpAuth,
  clearMcpAuth,
  updateMcp,
  type McpServer,
  type McpTool,
} from "../api";
import { HeaderRowsEditor, recordToRows, rowsToRecord, type HeaderRow } from "@/app/_components/HeaderRows";
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
  NumberInput,
} from "@mantine/core";
import { monoInput } from "@/app/_components/monoInput";
import { MCP_RUNTIME_COLOR, PLUGIN_COLOR } from "@/app/_components/badgeColors";
import { CredentialBadges } from "../_components/CredentialBadges";
import { parsePluginSource } from "@/domain/plugin/types";
import { useViewer } from "@/app/_lib/useViewer";

/**
 * How long the console watches a restart, and how often it asks.
 *
 * Sized against the work rather than against patience: starting a container
 * pulls an image through SSM, which the provisioner allows five minutes for,
 * and the settle probes add a few seconds after that. Watching for less would
 * report every cold image pull as a restart that failed.
 */
const RESTART_WATCH_MS = 6 * 60_000;
const RESTART_POLL_INTERVAL_MS = 5_000;

export default function McpDetailPage() {
  const params = useParams<{ name: string }>();
  const name = params.name;
  const router = useRouter();
  const viewer = useViewer();

  const [server, setServer] = useState<McpServer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const [tools, setTools] = useState<McpTool[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [managedStatus, setManagedStatus] = useState<ManagedMcpStatus | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  /**
   * Set once this page is gone. The restart watch runs for minutes inside an
   * event handler, and every poll costs a container inspect on the host — so it
   * has to stop when the operator navigates away, not when its clock runs out.
   */
  const abandoned = useRef(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const loaded = await getMcp(name);
      setServer(loaded);
      if (loaded.runtime === "managed") {
        void refreshStatus();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load MCP server");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  useEffect(() => {
    // Reset on mount as well as set on unmount: a remount reuses the ref, and a
    // page that came back would otherwise be born unable to watch anything.
    abandoned.current = false;
    return () => {
      abandoned.current = true;
    };
  }, []);

  async function runTest() {
    setTesting(true);
    setTestError(null);
    setTools(null);
    try {
      setTools(await testMcpConnection(name));
    } catch (e) {
      setTestError(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setTesting(false);
    }
  }

  /** What the container is actually doing; the stored entry cannot say. */
  async function refreshStatus() {
    try {
      setManagedStatus(await getManagedMcpStatus(name));
    } catch {
      // Status is informational: a deployment that cannot reach the provisioner
      // still shows the entry rather than an error page.
      setManagedStatus(null);
    }
  }

  /**
   * Re-creates the container against the namespace this app has now. The
   * recovery for a container that a redeploy left running somewhere unreachable.
   *
   * The request only queues the work — pulling an image outlives any response —
   * so the container itself is what gets watched, until it answers or the wait
   * runs out.
   */
  async function onRestart() {
    setRestarting(true);
    setError(null);
    try {
      await restartManagedMcp(name);
      const deadline = Date.now() + RESTART_WATCH_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_INTERVAL_MS));
        if (abandoned.current) {
          return;
        }
        const next = await getManagedMcpStatus(name).catch(() => null);
        if (abandoned.current) {
          return;
        }
        if (next) {
          setManagedStatus(next);
          if (next.reachable) {
            return;
          }
        }
      }
      // Running out of patience is not the same as the restart failing, and
      // saying so is the difference between "try again" and "go look at it".
      setError(
        `Still no answer from "${name}" after ${RESTART_WATCH_MS / 60_000} minutes. The restart may yet be running; reload to see where it got to.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to restart container");
    } finally {
      if (!abandoned.current) {
        setRestarting(false);
      }
    }
  }

  async function onDelete() {
    const managed = server?.runtime === "managed";
    const question = managed
      ? `Delete "${name}" and stop its container? This cannot be undone.`
      : `Delete MCP server "${name}"? This cannot be undone.`;
    if (!confirm(question)) {
      return;
    }
    try {
      // A managed entry and its container are one thing: removing the row
      // alone would leave a container running that nothing points at.
      await (managed ? removeManagedMcp(name) : deleteMcp(name));
      router.push("/tools");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete MCP server");
    }
  }

  if (loading) {
    return (
      <Text fz="sm" c="dimmed">
        Loading…
      </Text>
    );
  }

  if (error && !server) {
    return (
      <Stack gap="md">
        <BackLink />
        <Alert color="red" variant="light">
          {error}
        </Alert>
      </Stack>
    );
  }

  if (!server) {
    return null;
  }

  const headerEntries = Object.entries(server.headers);
  const plugin = server.source ? parsePluginSource(server.source) : null;

  return (
    <Stack gap="lg">
      <BackLink />

      <Group justify="space-between" align="flex-start" gap="md">
        <div>
          {/* The same badges the list shows; the detail page had none. */}
          <Group gap="xs" wrap="wrap">
            <Title order={1} fz="h2">
              {server.name}
            </Title>
            {plugin && (
              <Badge
                color={PLUGIN_COLOR}
                component={Link}
                href={`/plugins/${plugin.plugin}`}
                style={{ cursor: "pointer" }}
              >
                {plugin.plugin}
              </Badge>
            )}
            {server.runtime === "managed" && (
              <Badge color={MCP_RUNTIME_COLOR.managed}>managed</Badge>
            )}
            <CredentialBadges server={server} />
          </Group>
          <Text fz="sm" c="dimmed" mt={4}>
            {server.description}
          </Text>
          <Text fz="xs" c="dimmed" mt={4}>
            {server.url}
          </Text>
          {server.source && (
            // The repo owns url/description/content and rewrites them on sync;
            // headers, OAuth and a managed address stay this console's.
            <Text fz="xs" c="dimmed" mt={4}>
              Owned by {server.source} — its URL, description, and notes follow the repo;
              credentials are set here.
            </Text>
          )}
          {server.runtime === "managed" && (
            <Group gap={6} mt="xs" fz="xs" wrap="wrap">
              <Text fz="xs" c="dimmed">
                container
              </Text>
              {managedStatus === null ? (
                <Text fz="xs" c="dimmed">
                  unknown
                </Text>
              ) : !managedStatus.running ? (
                <Text fz="xs" c="red">
                  not running{managedStatus.detail ? ` — ${managedStatus.detail}` : ""}
                </Text>
              ) : managedStatus.reachable ? (
                <Text fz="xs" c="teal">
                  running · reachable
                </Text>
              ) : (
                // The state this page used to call "running": the container is
                // up and this app cannot address it. Restarting rejoins it to
                // the network namespace we have now.
                <Text fz="xs" c="red">
                  running · unreachable
                </Text>
              )}
              {server.image && (
                <Text fz="xs" ff="monospace" c="dimmed">
                  {server.image}
                </Text>
              )}
              {managedStatus && !managedStatus.reachable && viewer?.isAdmin && (
                <Anchor
                  component="button"
                  type="button"
                  fz="xs"
                  onClick={onRestart}
                  disabled={restarting}
                >
                  {restarting ? "Restarting…" : "Restart container"}
                </Anchor>
              )}
            </Group>
          )}
        </div>
        {!editing && viewer?.isAdmin && (
          <Group gap="xs" wrap="nowrap">
            <Button variant="default" onClick={() => setEditing(true)}>
              {server.source ? "Edit credentials" : "Edit"}
            </Button>
            {/* A repo-owned entry leaves through the sync's orphan removal,
                never this button — the API refuses the delete anyway. */}
            {!server.source && (
              <Button variant="default" color="red" onClick={onDelete}>
                Delete
              </Button>
            )}
          </Group>
        )}
      </Group>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {editing ? (
        <EditMcpForm
          server={server}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void refresh();
          }}
        />
      ) : (
        <>
          {server.content && (
            <section>
              <Text fz="sm" fw={500} c="dimmed" mb="xs">
                Content
              </Text>
              <Card>
                <Text ff="monospace" fz="sm" style={{ whiteSpace: "pre-wrap" }}>
                  {server.content}
                </Text>
              </Card>
            </section>
          )}

          <OAuthSection server={server} onChanged={() => void refresh()} editable={Boolean(viewer?.isAdmin)} />

          <section>
            <Text fz="sm" fw={500} c="dimmed" mb="xs">
              Headers
            </Text>
            {headerEntries.length === 0 ? (
              <Text fz="sm" c="dimmed">
                None.
              </Text>
            ) : (
              <Card padding={0}>
                {headerEntries.map(([key, value], index) => (
                  <Group
                    key={key}
                    justify="space-between"
                    px="md"
                    py="xs"
                    wrap="nowrap"
                    style={
                      index > 0
                        ? { borderTop: "1px solid var(--mantine-color-default-border)" }
                        : undefined
                    }
                  >
                    <Text ff="monospace" fz="sm">
                      {key}
                    </Text>
                    <Text ff="monospace" fz="sm" c="dimmed" truncate>
                      {value}
                    </Text>
                  </Group>
                ))}
              </Card>
            )}
          </section>

          <section>
            <Group gap="sm" mb="xs">
              <Text fz="sm" fw={500} c="dimmed">
                Connection
              </Text>
              <Button variant="default" size="compact-sm" onClick={runTest} loading={testing}>
                Test connection
              </Button>
            </Group>

            {testError && (
              <Alert color="red" variant="light">
                {testError}
              </Alert>
            )}

            {tools && (
              <div>
                <Text fz="sm" c="dimmed" mb="xs">
                  {tools.length} tool{tools.length === 1 ? "" : "s"} discovered.
                </Text>
                <Stack gap="xs">
                  {tools.map((tool) => (
                    <Card key={tool.name} padding="sm">
                      <Text ff="monospace" fz="sm" fw={500}>
                        {tool.name}
                      </Text>
                      {tool.description && (
                        <Text fz="sm" c="dimmed" mt={4}>
                          {tool.description}
                        </Text>
                      )}
                    </Card>
                  ))}
                </Stack>
              </div>
            )}
          </section>
        </>
      )}
    </Stack>
  );
}

/**
 * OAuth configuration for this registry entry (admin-only).
 *
 * This half is operator configuration — where the authorization server is —
 * shared by every project. The credentials that use it are per project and live
 * on the project page, which is what lets one entry serve a different app per
 * project.
 */
function OAuthSection({
  server,
  onChanged,
  editable,
}: {
  server: McpServer;
  onChanged: () => void;
  editable: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<string[] | null>(null);

  async function discover(authorizationServer?: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await discoverMcpAuth(server.name, authorizationServer);
      if (result.status === "choose") {
        // The resource advertises several; RFC 9728 puts the choice on us, and
        // taking the first would bind every project's tokens to it silently.
        setChoices(result.authorizationServers);
        return;
      }
      setChoices(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Discovery failed");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    setError(null);
    try {
      await clearMcpAuth(server.name);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to clear OAuth configuration");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <Group gap="sm" mb="xs">
        <Text fz="sm" fw={500} c="dimmed">
          OAuth
        </Text>
        {editable && <Button
          variant="default"
          size="compact-sm"
          onClick={() => void discover()}
          loading={busy}
        >
          {server.auth ? "Rediscover" : "Discover"}
        </Button>}
        {editable && server.auth && (
          <Button
            variant="default"
            color="red"
            size="compact-sm"
            onClick={() => void clear()}
            disabled={busy}
          >
            Clear
          </Button>
        )}
      </Group>

      {error && (
        <Text fz="sm" c="red" mb="xs">
          {error}
        </Text>
      )}

      {choices && (
        <Alert color="yellow" variant="light" mb="xs">
          <Text fz="sm">
            This resource advertises more than one authorization server. Choose one:
          </Text>
          <Group gap="xs" mt="xs">
            {choices.map((issuer) => (
              <Button
                key={issuer}
                variant="default"
                size="compact-xs"
                ff="monospace"
                onClick={() => void discover(issuer)}
              >
                {issuer}
              </Button>
            ))}
          </Group>
        </Alert>
      )}

      {server.auth ? (
        <Card component="dl" m={0}>
          {(
            [
              ["Resource", server.auth.resource],
              ["Authorization server", server.auth.authorizationServer],
              ["Authorize", server.auth.authorizationEndpoint],
              ["Token", server.auth.tokenEndpoint],
              [
                "Registration",
                server.auth.registrationEndpoint ??
                  "not offered — clients must be registered by hand",
              ],
              ["Client auth", server.auth.tokenEndpointAuthMethod],
            ] as const
          ).map(([label, value], index) => (
            <Group
              key={label}
              justify="space-between"
              gap="md"
              wrap="nowrap"
              py={4}
              style={
                index > 0
                  ? { borderTop: "1px solid var(--mantine-color-default-border)" }
                  : undefined
              }
            >
              <Text component="dt" fz="sm" c="dimmed" style={{ flexShrink: 0 }}>
                {label}
              </Text>
              <Text
                component="dd"
                fz="xs"
                ff="monospace"
                ta="right"
                m={0}
                style={{ overflowWrap: "anywhere" }}
              >
                {value}
              </Text>
            </Group>
          ))}
        </Card>
      ) : (
        <Text fz="sm" c="dimmed">
          Not configured. Discovery reads the server&apos;s published metadata; projects then
          connect their own credentials from their project page.
        </Text>
      )}
    </section>
  );
}

function BackLink() {
  return (
    <Anchor component={Link} href="/tools" fz="sm" c="dimmed">
      ← Back to tools
    </Anchor>
  );
}

function EditMcpForm({
  server,
  onCancel,
  onSaved,
}: {
  server: McpServer;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [url, setUrl] = useState(server.url);
  const [image, setImage] = useState(server.image ?? "");
  const [containerPort, setContainerPort] = useState(String(server.containerPort ?? 3000));
  const [envRefs, setEnvRefs] = useState((server.envRefs ?? []).join("\n"));
  const [environmentRows, setEnvironmentRows] = useState<HeaderRow[]>(
    recordToRows(server.environment ?? {}),
  );
  const [args, setArgs] = useState((server.args ?? []).join("\n"));
  const [endpointPath, setEndpointPath] = useState(server.endpointPath ?? "/mcp");
  const [description, setDescription] = useState(server.description ?? "");
  const [content, setContent] = useState(server.content ?? "");
  const [rows, setRows] = useState<HeaderRow[]>(recordToRows(server.headers));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The repo owns a synced entry's document fields; the console keeps the
  // credentials and (for managed) the workload. Locked fields are excluded
  // from the patch too — a disabled input still holds a value, and sending it
  // would earn the 403 the API answers document edits with.
  const documentLocked = Boolean(server.source);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const headers = rowsToRecord(rows);
      if (server.runtime === "managed") {
        await updateManagedMcp(server.name, {
          image,
          containerPort: Number(containerPort),
          envRefs: envRefs
            .split(/[\s,]+/)
            .map((ref) => ref.trim())
            .filter(Boolean),
          environment: rowsToRecord(environmentRows),
          args: args
            .split("\n")
            .map((arg) => arg.trim())
            .filter(Boolean),
          endpointPath,
          ...(documentLocked ? {} : { description, content }),
          headers,
        });
      } else if (documentLocked) {
        await updateMcp(server.name, { headers });
      } else {
        await updateMcp(server.name, {
          url,
          description,
          content,
          headers,
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <Stack gap="md">
        {server.runtime === "managed" ? (
          <>
            <TextInput label="URL" value={url} readOnly description="Set by the managed runtime." />
            <TextInput
              label="Image"
              value={image}
              onChange={(e) => setImage(e.currentTarget.value)}
              required
              styles={monoInput}
            />
            <NumberInput
              label="Container port"
              value={containerPort}
              onChange={(value) => setContainerPort(String(value))}
              min={1}
              max={65535}
              required
            />
            <TextInput
              label="Environment references"
              value={envRefs}
              onChange={(e) => setEnvRefs(e.currentTarget.value)}
              placeholder="/env/prod/mcp-image-fetch"
              description="SSM parameter names, not values — the secrets never pass through here."
              inputWrapperOrder={["label", "input", "description", "error"]}
              styles={monoInput}
            />
            <HeaderRowsEditor
              rows={environmentRows}
              onChange={setEnvironmentRows}
              caption="Environment variables"
              emptyHint="No direct environment variables."
              addLabel="+ Add variable"
              keyPlaceholder="VARIABLE_NAME"
              valuePlaceholder="value"
            />
            <Textarea
              label="Arguments"
              value={args}
              onChange={(e) => setArgs(e.currentTarget.value)}
              placeholder={
                "--transport\nstreamable-http\n--address\n0.0.0.0:{{PORT}}\n--allowed-hosts\n*"
              }
              autosize
              minRows={3}
              description="One container entrypoint argument per line. {{PORT}} becomes the effective listen port; arguments are not run through a shell."
              inputWrapperOrder={["label", "input", "description", "error"]}
              styles={monoInput}
            />
            <TextInput
              label="Endpoint path"
              value={endpointPath}
              onChange={(e) => setEndpointPath(e.currentTarget.value)}
              placeholder="/mcp"
              required
              styles={monoInput}
            />
            <Text fz="xs" c="dimmed">
              Changing the image, port, environment, arguments, or endpoint automatically
              restarts the container.
            </Text>
          </>
        ) : (
          <TextInput
            label="URL"
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
            type="url"
            required
            disabled={documentLocked}
            description={
              documentLocked
                ? "Owned by the plugin repository."
                : "Changing the URL drops the stored headers and OAuth block — credentials belong to the address they were entered for."
            }
            inputWrapperOrder={["label", "input", "description", "error"]}
          />
        )}
        <TextInput
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          placeholder="One-line summary shown to the model"
          disabled={documentLocked}
          {...(documentLocked ? { description: "Owned by the plugin repository." } : {})}
          inputWrapperOrder={["label", "input", "description", "error"]}
        />
        <Textarea
          label="Content (markdown)"
          value={content}
          onChange={(e) => setContent(e.currentTarget.value)}
          placeholder="Setup steps, caveats, links…"
          autosize
          minRows={documentLocked ? 3 : 8}
          maxRows={30}
          disabled={documentLocked}
          description={
            documentLocked
              ? "Owned by the plugin repository — edit it there; the sync applies it."
              : "Operator notes for the console. Not sent to the model — only the description is."
          }
          inputWrapperOrder={["label", "input", "description", "error"]}
          styles={monoInput}
        />

        <HeaderRowsEditor rows={rows} onChange={setRows} />
        <Text fz="xs" c="dimmed">
          Masked values keep the stored secret. Type a new value to replace it.
        </Text>

        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}

        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" loading={submitting}>
            Save
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
