import type { PoolClient } from "pg";
import { MIGRATION_LOCK } from "./migrations";
import { keys } from "./keys";
import {
  agentApiTokenContext,
  agentMcpHeadersContext,
  mcpConnectionSecretContext,
  slackSecretContext,
  sourceReferenceContext,
  teamsSecretContext,
  telegramSecretContext,
  triggerSecretContext,
} from "@/domain/security/secretContext";

type Item = Record<string, unknown>;
export type ReencryptSecret = (value: string, previousContext: string, nextContext: string) => string;

/** These are the addresses already stored by releases before the Agent rename. */
const LEGACY_SCOPE = "project";
const FIELD_NAMES = /Projects(?=$|[A-Z_])|Project(?=$|[A-Z_])|projects(?=$|[A-Z_])|project(?=$|[A-Z_])/g;

function record(value: unknown): Item | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Item : null;
}

function renamedField(key: string): string {
  return key.replace(FIELD_NAMES, (word) => ({
    Projects: "Agents", Project: "Agent", projects: "agents", project: "agent",
  })[word]!);
}

/** Rename only typed product objects; model input, tool payloads and metadata remain opaque. */
function renameFields(value: Item): void {
  for (const key of Object.keys(value)) {
    const next = renamedField(key);
    if (next === key) continue;
    if (Object.hasOwn(value, next)) throw new Error(`Agent data migration field collision: ${key}`);
    value[next] = value[key];
    delete value[key];
  }
}

function renameTypedChildren(row: Item): void {
  for (const key of ["configuration", "job", "config", "file", "delta", "reference"]) {
    const child = record(row[key]);
    if (!child) continue;
    renameFields(child);
    for (const nested of ["postprocess", "sourceRefresh", "source"]) {
      const part = record(child[nested]);
      if (part) renameFields(part);
    }
  }
  // Workspace rows keep their typed entity under `value`; events and native
  // checkpoint bytes can contain user data and are deliberately not rewritten.
  if (typeof row.PK === "string" && row.PK.startsWith("WORKSPACE#") &&
    typeof row.SK === "string" && !row.SK.startsWith("EVENT#")) {
    const value = record(row.value);
    if (value) renameFields(value);
  }
}

function address(value: string): string {
  if (value.startsWith("PROJECT#")) return keys.agentPartition(value.slice("PROJECT#".length));
  if (value.startsWith("ARTIFACTPROJECT#")) return keys.artifactAgentPartition(value.slice("ARTIFACTPROJECT#".length));
  if (value.startsWith("TRACEPROJECT#")) return keys.traceAgentPartition(value.slice("TRACEPROJECT#".length));
  if (value === "TYPE#PROJECT") return keys.typePartition("AGENT");
  if (value.startsWith("RUNSLOT#project-token:")) return keys.runSlotPartition(`agent-token:${value.slice("RUNSLOT#project-token:".length)}`);
  return value.replace("#project-token:", "#agent-token:");
}

function legacyAgentName(row: Item): string | undefined {
  if (typeof row.projectName === "string") return row.projectName;
  if (typeof row.PK === "string" && row.PK.startsWith("PROJECT#")) return row.PK.slice("PROJECT#".length);
  if (typeof row.name === "string" && row.entityType === "PROJECT") return row.name;
  const referenced = record(row.reference)?.projectName;
  return typeof referenced === "string" ? referenced : undefined;
}

function validateLegacyIdentity(row: Item): void {
  if (typeof row.PK !== "string" || !row.PK.startsWith("PROJECT#")) return;
  const name = row.PK.slice("PROJECT#".length);
  const configuration = record(row.configuration);
  if ((typeof row.projectName === "string" && row.projectName !== name) ||
    (row.entityType === "PROJECT" && row.name !== name) ||
    (typeof configuration?.projectName === "string" && configuration.projectName !== name)) {
    throw new Error("Legacy Agent row name disagrees with its partition key");
  }
}

function legacyContext(name: string, ...parts: string[]): string {
  return JSON.stringify([LEGACY_SCOPE, name, ...parts]);
}

function reencryptField(row: Item, field: string, before: string, after: string, reencrypt: ReencryptSecret): number {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) return 0;
  row[field] = reencrypt(value, before, after);
  return 1;
}

function reencryptBindings(value: unknown, agentName: string, reencrypt: ReencryptSecret): number {
  if (!Array.isArray(value)) return 0;
  let count = 0;
  for (const entry of value) {
    const binding = record(entry);
    const headers = record(binding?.headers);
    if (!binding || !headers || typeof binding.name !== "string") continue;
    const previous = legacyContext(agentName, "agent", "mcp", binding.name);
    const next = agentMcpHeadersContext(agentName, binding.name);
    for (const [header, secret] of Object.entries(headers)) {
      if (typeof secret !== "string") continue;
      headers[header] = reencrypt(secret, JSON.stringify([previous, header]), JSON.stringify([next, header]));
      count += 1;
    }
  }
  return count;
}

function reencryptAgentSecrets(row: Item, original: Item, reencrypt: ReencryptSecret): number {
  const name = legacyAgentName(original);
  const type = original.entityType;
  if (!name) return 0;
  let count = 0;
  if (type === "PROJECT") {
    const slack = record(row.slack);
    if (slack) for (const [field, label] of [["botToken", "bot-token"], ["signingSecret", "signing-secret"]] as const) {
      count += reencryptField(slack, field, legacyContext(name, "slack", label), slackSecretContext(name, label), reencrypt);
    }
    const telegram = record(row.telegram);
    if (telegram) for (const [field, label] of [["botToken", "bot-token"], ["webhookSecret", "webhook-secret"]] as const) {
      count += reencryptField(telegram, field, legacyContext(name, "telegram", label), telegramSecretContext(name, label), reencrypt);
    }
    const teams = record(row.teams);
    if (teams) count += reencryptField(teams, "appPassword", legacyContext(name, "teams", "app-password"), teamsSecretContext(name), reencrypt);
    count += reencryptBindings(record(row.configuration)?.mcpList, name, reencrypt);
  }
  if (type === "VERSION") count += reencryptBindings(row.mcpList, name, reencrypt);
  if (type === "APITOKEN") count += reencryptField(row, "token", legacyContext(name, "api-token"), agentApiTokenContext(name), reencrypt);
  if (type === "Trigger" && typeof row.triggerId === "string") {
    count += reencryptField(row, "secret", legacyContext(name, "trigger", row.triggerId, "secret"), triggerSecretContext(name, row.triggerId), reencrypt);
  }
  if (type === "MCPCONNECTION" && typeof row.serverName === "string") {
    const server = row.serverName;
    if (row.clientFromRegistry !== true) count += reencryptField(row, "clientSecret", legacyContext(name, "mcp", server, "client-secret"), mcpConnectionSecretContext(name, server, "client-secret"), reencrypt);
    for (const field of ["accessToken", "refreshToken"] as const) {
      const label = field === "accessToken" ? "access-token" : "refresh-token";
      count += reencryptField(row, field, legacyContext(name, "mcp", server, label), mcpConnectionSecretContext(name, server, label), reencrypt);
    }
  }
  if (type === "SourceReference") {
    const reference = record(row.reference);
    if (reference && typeof reference.id === "string") {
      count += reencryptField(reference, "encryptedUrl", legacyContext(name, "source-reference", reference.id, "url"), sourceReferenceContext(name, reference.id), reencrypt);
    }
  }
  return count;
}

function renameActorField(container: Item): void {
  if (typeof container.actor === "string" && container.actor.startsWith("project-token:")) {
    container.actor = `agent-token:${container.actor.slice(14)}`;
  }
  const actor = record(container.actor);
  if (actor?.kind === "project-token") actor.kind = "agent-token";
}

function encryptedLeaves(value: unknown, path = "data"): Array<{ path: string; value: string }> {
  if (typeof value === "string" && /^enc:v[12]:/.test(value)) return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => encryptedLeaves(item, `${path}[${index}]`));
  const object = record(value);
  return object ? Object.entries(object).flatMap(([key, item]) => encryptedLeaves(item, `${path}.${key}`)) : [];
}

/** Convert one JSONB row without changing user-authored text or model/tool payloads. */
export function convertLegacyAgentItem(original: Item, reencrypt: ReencryptSecret): { item: Item; secrets: number } {
  validateLegacyIdentity(original);
  const item = structuredClone(original);
  const secrets = reencryptAgentSecrets(item, original, reencrypt);
  renameFields(item);
  renameTypedChildren(item);
  for (const key of ["PK", "SK", "GSI1PK", "GSI1SK", "GSI2PK", "GSI2SK"]) {
    if (typeof item[key] === "string") item[key] = address(item[key]);
  }
  if (item.entityType === "PROJECT") item.entityType = "AGENT";
  if (item.entityType === "PROJECT_TOMBSTONE") item.entityType = "AGENT_TOMBSTONE";
  if (item.entityType === "AuditEvent") {
    if (typeof item.action === "string" && item.action.startsWith("project.")) item.action = `agent.${item.action.slice(8)}`;
    if (typeof item.target === "string" && item.target.startsWith("project:")) item.target = `agent:${item.target.slice(8)}`;
  }
  renameActorField(item);
  for (const key of ["job", "delta", "value"]) {
    const child = record(item[key]);
    if (child) renameActorField(child);
  }
  if ((typeof original.PK === "string" && original.PK.startsWith("PROJECT#")) || original.entityType === "SourceReference") {
    const remaining = new Set(encryptedLeaves(item).map(entry => entry.value));
    const unchanged = encryptedLeaves(original).find(entry => remaining.has(entry.value));
    if (unchanged) throw new Error(`Agent data migration has an unconverted encrypted field at ${unchanged.path}`);
  }
  return { item, secrets };
}

/** One transaction on a restored database. The source database is never opened here. */
export async function convertLegacyAgentDatabase(client: PoolClient, reencrypt: ReencryptSecret): Promise<{ rows: number; changed: number; secrets: number }> {
  await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
  await client.query("LOCK TABLE items, runtime_sessions IN ACCESS EXCLUSIVE MODE");
  const versions = await client.query<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version");
  const applied = new Set(versions.rows.map(row => row.version));
  if (!applied.has(8) || applied.has(9)) throw new Error("Agent data migration requires a version 8 restored database without version 9");
  const rows = await client.query<{ pk: string; sk: string; data: Item }>("SELECT pk, sk, data FROM items ORDER BY pk, sk");
  if (rows.rows.some(row => row.pk.startsWith("AGENT#") || row.data.entityType === "AGENT")) throw new Error("Restored database already contains Agent-format rows");
  let changed = 0;
  let secrets = 0;
  for (const row of rows.rows) {
    if (row.data.PK !== row.pk || row.data.SK !== row.sk) throw new Error("Item key columns disagree with stored JSON");
    const converted = convertLegacyAgentItem(row.data, reencrypt);
    secrets += converted.secrets;
    if (JSON.stringify(converted.item) === JSON.stringify(row.data)) continue;
    const result = await client.query(
      "UPDATE items SET pk = $1, sk = $2, data = $3::jsonb WHERE pk = $4 AND sk = $5",
      [converted.item.PK, converted.item.SK, JSON.stringify(converted.item), row.pk, row.sk],
    );
    if (result.rowCount !== 1) throw new Error("Agent data migration lost an item during conversion");
    changed += 1;
  }
  const remaining = await client.query<{ count: string }>(
    "SELECT count(*) FROM items WHERE pk LIKE 'PROJECT#%' OR data ? 'projectName'",
  );
  if (Number(remaining.rows[0]?.count) !== 0) throw new Error("Legacy Agent rows remain after conversion");
  return { rows: rows.rowCount ?? rows.rows.length, changed, secrets };
}
