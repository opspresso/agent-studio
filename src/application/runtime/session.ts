import type { AgentInputItem, Session, RunToolApprovalItem } from "@openai/agents";
import { createHash } from "node:crypto";
import { brotliCompress, brotliDecompress, constants } from "node:zlib";
import { promisify } from "node:util";
import type { RuntimeSessionRepository, RuntimeSessionRow, RuntimeApproval, RuntimeApprovalDecision } from "@/domain/execution/runtimeSession";
import { CONTEXT_ENCRYPTED_PREFIX, type SecretCipher } from "@/domain/security/secretCipher";
import { runtimeSessionContext } from "@/domain/security/secretContext";
import type { AgentConfiguration } from "@/domain/project/types";
import { ConflictError, ValidationError } from "@/application/errors";
import { PiiFilter } from "@/application/llm/pii";
import { maskValues, restoreValues } from "./messages";
import type { RuntimeCheckpoint, RuntimeTurnPersistence } from "./types";
export type { RuntimeGraphSnapshot, RuntimeAgentSnapshot, RuntimeCheckpoint, RuntimeTurnPersistence } from "./types";
import { ImageRegistry, type ImageHandle } from "@/application/llm/agentAssembly";
import { MAX_IMAGES_PER_TURN } from "@/domain/llm/imageLimits";
import { MS_PER_DAY } from "@/shared/date";
import { historyImages } from "./historyImages";

export const MAX_RUNTIME_STATE_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_ITEMS = 256;
const MAX_SESSION_TEXT_CHARS = 150_000;
const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);

export interface RuntimeSessionServices {
  repository: RuntimeSessionRepository;
  cipher: SecretCipher;
  retentionDays: number;
}

interface SessionDocument {
  format: 1;
  items: AgentInputItem[];
  checkpoint?: RuntimeCheckpoint;
  images?: ImageHandle[];
  nextImageId?: number;
}

/** Buffered SDK Session: history and a pending RunState commit in one database CAS. */
export class StudioSession implements Session {
  constructor(private readonly id: string, public items: AgentInputItem[]) {}
  async getSessionId() { return this.id; }
  async getItems(limit?: number) { return structuredClone(limit === undefined ? this.items : limit <= 0 ? [] : this.items.slice(-limit)); }
  async addItems(items: AgentInputItem[]) { this.items.push(...structuredClone(items)); }
  async popItem() { return this.items.pop(); }
  async clearSession() { this.items = []; }
}

async function encode(document: SessionDocument, services: RuntimeSessionServices, id: string, owner: string): Promise<string> {
  let bytes = 0;
  const json = JSON.stringify(document, (_key, value: unknown) => {
    if (typeof value === "string") bytes += Buffer.byteLength(value, "utf8");
    if (bytes > MAX_RUNTIME_STATE_BYTES) throw new ValidationError("Runtime session exceeds its storage limit");
    return value;
  });
  if (Buffer.byteLength(json, "utf8") > MAX_RUNTIME_STATE_BYTES) throw new ValidationError("Runtime session exceeds its storage limit");
  const packed = await compress(Buffer.from(json), { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
  return services.cipher.encrypt(packed.toString("base64"), runtimeSessionContext(id, owner));
}

async function decode(row: RuntimeSessionRow, services: RuntimeSessionServices): Promise<SessionDocument> {
  if (!row.payload.startsWith(CONTEXT_ENCRYPTED_PREFIX)) throw new ValidationError("Runtime sessions require authenticated encryption");
  const compressed = services.cipher.decrypt(row.payload, runtimeSessionContext(row.sessionId, row.ownerEmail));
  const json = (await decompress(Buffer.from(compressed, "base64"), { maxOutputLength: MAX_RUNTIME_STATE_BYTES })).toString("utf8");
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object" || !("format" in value) || value.format !== 1 || !("items" in value) || !Array.isArray(value.items)) throw new ValidationError("Invalid runtime session");
  return value as SessionDocument;
}

export function runtimeFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item,
  )).digest("hex");
}

export function approvalId(item: RunToolApprovalItem): string {
  return runtimeFingerprint([item.agent.name, item.toolName, item.rawItem]);
}

export async function readRuntimeSession(services: RuntimeSessionServices, sessionId: string, ownerEmail: string) {
  const row = await services.repository.get(sessionId, ownerEmail);
  return row ? { row, document: await decode(row, services) } : null;
}

export async function pendingRuntimeApproval(services: RuntimeSessionServices, sessionId: string, ownerEmail: string) {
  const saved = await readRuntimeSession(services, sessionId, ownerEmail);
  const checkpoint = saved?.document.checkpoint;
  return saved && checkpoint ? { revision: saved.row.revision, status: checkpoint.status, approvals: checkpoint.approvals } : null;
}

/** Drop complete old turns, keeping the latest turn whole and reporting any loss. */
function boundedHistory(items: AgentInputItem[]): { items: AgentInputItem[]; dropped: boolean } {
  let start = 0;
  const sizes = items.map((item) => JSON.stringify(item, (key, value: unknown) => key === "image" ? "" : value).length);
  let total = sizes.reduce((sum, value) => sum + value, 0);
  while (items.length - start > MAX_SESSION_ITEMS || total > MAX_SESSION_TEXT_CHARS) {
    const next = items.findIndex((item, index) => index > start && (item.type === "message" || item.type === undefined) && item.role === "user");
    if (next < 0) break;
    for (let index = start; index < next; index += 1) total -= sizes[index] ?? 0;
    start = next;
  }
  return { items: items.slice(start), dropped: start > 0 };
}

export async function openRuntimeSession(
  services: RuntimeSessionServices,
  scope: { sessionId: string; ownerEmail: string; projectName: string; configuration: AgentConfiguration },
  resume?: { revision: number; decisions: RuntimeApprovalDecision[] },
): Promise<RuntimeTurnPersistence> {
  const saved = await readRuntimeSession(services, scope.sessionId, scope.ownerEmail);
  if (saved && saved.row.projectName !== scope.projectName) throw new ConflictError("Runtime session belongs to another project");
  let revision = saved?.row.revision ?? null;
  const document: SessionDocument = saved?.document ?? { format: 1, items: [] };
  const checkpoint = document.checkpoint;
  if (checkpoint && !resume) throw new ConflictError("This chat is waiting for an approval decision");
  if (resume && (!checkpoint || checkpoint.status !== "pending" || resume.revision !== revision)) throw new ConflictError("This approval is no longer pending");
  if (checkpoint && !checkpoint.configuration) throw new ConflictError("This pending run uses retired Version settings; discard it before starting a new run");
  if (checkpoint && runtimeFingerprint(checkpoint.configuration) !== runtimeFingerprint(scope.configuration)) throw new ConflictError("The Agent configuration changed while approval was pending; discard this run and start again");
  if (resume && (!resume.decisions.length || new Set(resume.decisions.map((entry) => entry.id)).size !== resume.decisions.length || resume.decisions.some((entry) => !checkpoint?.approvals.some((approval) => approval.id === entry.id)))) throw new ValidationError("Unknown or duplicate approval decision");
  const filter = checkpoint ? (checkpoint.input.parameters?.piiFiltering || checkpoint.pii.length ? PiiFilter.restoreSnapshot(checkpoint.pii) : undefined) : scope.configuration.parameters.piiFiltering ? new PiiFilter() : undefined;
  const history = checkpoint ? { items: document.items, dropped: false } : boundedHistory(document.items);
  const media = checkpoint ? { items: history.items, images: [], dropped: 0 } : historyImages(history.items);
  const session = new StudioSession(scope.sessionId, filter ? maskValues(filter, media.items) as AgentInputItem[] : structuredClone(media.items));
  const bindings = Object.assign(Object.create(null) as Record<string, string>, checkpoint?.bindings ?? {});
  const previousItemCount = checkpoint?.previousItemCount ?? session.items.length;
  const images = new ImageRegistry({ next: document.nextImageId ?? 1 });
  images.restore(document.images ?? []);
  if (!document.images) for (const image of media.images) images.add(image, "from the conversation");
  const write = async (next: SessionDocument) => {
    const payload = await encode(next, services, scope.sessionId, scope.ownerEmail);
    const nextRevision = await services.repository.save({ sessionId: scope.sessionId, ownerEmail: scope.ownerEmail, projectName: scope.projectName, payload, expiresAt: new Date(Date.now() + services.retentionDays * MS_PER_DAY).toISOString() }, revision);
    if (nextRevision === null) throw new ConflictError("Runtime session was changed by another run");
    revision = nextRevision;
  };
  // Claims precede any model/tool effect. A crashed approved run is never replayed automatically.
  if (checkpoint) await write({ ...document, checkpoint: { ...checkpoint, status: "running" } });
  else if (!saved) await write(document);
  return {
    session, filter, ...(checkpoint ? { checkpoint } : {}), ...(resume ? { decisions: resume.decisions } : {}),
    warnings: [...(history.dropped ? ["Earlier SDK Session turns were omitted from this run's context."] : []), ...(media.dropped ? [`${media.dropped} earlier image(s) were omitted from this run's SDK Session context.`] : [])],
    images: [...images.list()], nextImageId: images.nextId,
    checkBinding(key, fingerprint) {
      if (checkpoint && key in bindings && bindings[key] !== fingerprint) throw new ConflictError("An Agent configuration or connection changed while approval was pending");
      bindings[key] = fingerprint;
    },
    async commit(input, state, items, graph) {
      const interruptions = state.getInterruptions();
      const approvals = interruptions.map((item): RuntimeApproval => {
        const scoped = Object.entries(graph.agents).find(([key, saved]) => {
          if (!key.endsWith(`/${item.agent.name}`) || !saved.pii) return false;
          const ids = graph.identifiers[key.slice(0, key.lastIndexOf("/"))];
          return !ids?.prefix || ("callId" in item.rawItem && item.rawItem.callId.startsWith(`call_${ids.prefix}_`));
        })?.[1];
        const restorer = filter ?? (scoped?.pii ? PiiFilter.restoreSnapshot(scoped.pii) : undefined);
        const args = "arguments" in item.rawItem ? String(item.rawItem.arguments) : "{}";
        return { id: approvalId(item), agent: item.agent.name, tool: item.toolName ?? ("name" in item.rawItem ? String(item.rawItem.name) : "tool"), arguments: restorer?.restore(args) ?? args };
      });
      const { signal: _signal, runtime: _runtime, now, ...rest } = input;
      void _signal; void _runtime;
      const restoredItems = filter ? restoreValues(filter, items) as AgentInputItem[] : items;
      const retained = new ImageRegistry({ next: Math.max(images.nextId, graph.nextImageId ?? 1) });
      retained.restore([...images.list(), ...Object.values(graph.agents).flatMap((entry) => [...entry.images])]);
      await write({ format: 1, items: restoredItems, images: retained.list().slice(-MAX_IMAGES_PER_TURN), nextImageId: retained.nextId, ...(approvals.length ? {
        checkpoint: { status: "pending", state: state.toString(), approvals, input: { ...rest, ...(now ? { now: now.toISOString() } : {}) }, configuration: scope.configuration, pii: filter?.snapshot() ?? [], bindings, previousItemCount, previousImageIds: checkpoint?.previousImageIds ?? images.list().map((image) => image.id), graph },
      } : {}) });
      session.items = items;
      return approvals;
    },
  };
}

export async function discardRuntimeCheckpoint(services: RuntimeSessionServices, sessionId: string, ownerEmail: string, revision: number): Promise<void> {
  const saved = await readRuntimeSession(services, sessionId, ownerEmail);
  if (!saved || saved.row.revision !== revision || !saved.document.checkpoint) throw new ConflictError("This approval is no longer pending");
  const checkpoint = saved.document.checkpoint;
  const images = checkpoint.graph.agents[`root/${saved.row.projectName}`]?.images.filter((image) => checkpoint.previousImageIds?.includes(image.id));
  const next: SessionDocument = { format: 1, items: saved.document.items.slice(0, checkpoint.previousItemCount), images, nextImageId: saved.document.nextImageId };
  const { payload: _old, revision: _revision, ...row } = saved.row;
  void _old; void _revision;
  if (await services.repository.save({ ...row, payload: await encode(next, services, sessionId, ownerEmail) }, revision) === null) throw new ConflictError("Runtime session was changed by another run");
}
