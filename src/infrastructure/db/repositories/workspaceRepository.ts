import type { WorkspaceRepository, WorkspaceWrite } from "@/domain/workspace/repository";
import type { Workspace, WorkspaceRun, WorkspaceEvent } from "@/domain/workspace/types";
import type { CodingApproval } from "@/domain/coding/types";
import { mayAdvanceCodingApproval } from "@/domain/coding/types";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";
import { keys } from "../keys";
import { conditions, getItem, queryItems, transact, type Item, type TransactOp } from "../store";
import { chatActivityFields, chatIsLive } from "../chatLifecycle";
import { projectIsLive } from "../projectLifecycle";
import { expiresAtSeconds, expiresAtFromNow, isExpired, RETENTION } from "../ttl";

function page(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKSPACE_LIMITS.maxPage) {
    throw new Error("invalid workspace page limit");
  }
  return limit;
}

function expiry(at: string): number {
  return expiresAtSeconds(at, RETENTION.workspaceDays);
}

function value<T>(item: Item | null): T | null {
  return item && !isExpired(item.expiresAt, Date.now()) ? item.value as T : null;
}

function workspaceItem(workspace: Workspace): Item {
  return {
    ...keys.workspace(workspace.id), entityType: "WORKSPACE", value: workspace,
    revision: workspace.revision, ownerEmail: workspace.ownerEmail,
    GSI1PK: keys.workspaceOwner(workspace.ownerEmail), GSI1SK: `${workspace.createdAt}#${workspace.id}`,
    ...(workspace.status !== "closed" && workspace.status !== "suspended" ? {
      GSI2PK: keys.workspaceDue(), GSI2SK: keys.workspaceDueSort(workspace.dueAt, workspace.id),
    } : { expiresAt: expiry(workspace.updatedAt) }),
  };
}

function assertChild(workspaceId: string, child: { workspaceId: string }): void {
  if (child.workspaceId !== workspaceId) throw new Error("workspace child scope mismatch");
}

/** Revision checks fence every child write, including terminal events and approvals. */
export const workspaceRepository: WorkspaceRepository = {
  async create(workspace, session) {
    assertChild(workspace.id, session);
    if (workspace.revision !== 0 || workspace.sessionId !== session.id || workspace.runtime !== session.runtime) throw new Error("invalid initial workspace");
    await transact([
      { kind: "check", key: keys.project(workspace.projectName), condition: projectIsLive },
      { kind: "update", key: keys.chat(workspace.chatId), patch: row => ({ ...row, workspaceId: workspace.id }), condition: row =>
        chatIsLive(row) && row?.ownerEmail === workspace.ownerEmail &&
        row?.projectName === workspace.projectName && row?.workspaceId === undefined && row?.activeRunId === undefined &&
        !isExpired(row?.expiresAt, Date.now()) },
      { kind: "put", item: workspaceItem(workspace), condition: conditions.notExists },
      { kind: "put", item: { ...keys.workspaceChat(workspace.chatId), value: workspace.id,
        expiresAt: expiry(workspace.updatedAt) }, condition: conditions.notExists },
      { kind: "put", item: { ...keys.workspaceChild(workspace.id, "SESSION", session.id), value: session,
        expiresAt: expiry(session.updatedAt) }, condition: conditions.notExists },
    ]);
  },
  async get(id) { return value<Workspace>(await getItem(keys.workspace(id))); },
  async forChat(chatId) {
    const id = value<string>(await getItem(keys.workspaceChat(chatId)));
    return id ? this.get(id) : null;
  },
  async list(ownerEmail, limit) {
    const rows = await queryItems({ index: "GSI1", pk: keys.workspaceOwner(ownerEmail),
      forward: false, limit: page(limit), notExpiredAt: expiresAtFromNow(0) });
    return rows.map(row => row.value as Workspace);
  },
  async due(now, limit) {
    const rows = await queryItems({ index: "GSI2", pk: keys.workspaceDue(),
      sk: keys.workspaceDueRange(now), limit: page(limit), notExpiredAt: expiresAtFromNow(0, Date.parse(now)) });
    return rows.map(row => row.value as Workspace);
  },
  async write(change: WorkspaceWrite) {
    const { workspace, expectedRevision, session, sandbox, run, approval, request, delivery, events = [] } = change;
    if (workspace.revision !== expectedRevision + 1) throw new Error("workspace revision must advance once");
    const operations: TransactOp[] = [{ kind: "put", item: workspaceItem(workspace), condition: row => {
      const previous = row?.value as Workspace | undefined;
      return row?.revision === expectedRevision && previous?.ownerEmail === workspace.ownerEmail &&
        previous?.chatId === workspace.chatId && previous?.projectName === workspace.projectName &&
        previous?.sessionId === workspace.sessionId && previous?.runtime === workspace.runtime &&
        (previous?.status !== "closed" || (change.reopenOwner === workspace.ownerEmail && !previous.deleteRequestedAt &&
          workspace.status === "active" && run?.status === "queued" && !!request)) && !isExpired(row?.expiresAt, Date.now()) &&
        (!approval || mayAdvanceCodingApproval(previous!, approval)) &&
        (!previous?.deleteRequestedAt || workspace.deleteRequestedAt === previous.deleteRequestedAt);
    } }];
    for (const [kind, child] of [["SESSION", session], ["SANDBOX", sandbox], ["RUN", run], ["APPROVAL", approval]] as const) {
      if (!child) continue;
      assertChild(workspace.id, child);
      operations.push({ kind: "put", item: { ...keys.workspaceChild(workspace.id, kind, child.id), value: child,
        expiresAt: expiry(workspace.updatedAt) } });
    }
    if (request) {
      if (run?.id !== request.runId || run.status !== "queued" || workspace.activeRunId !== run.id) {
        throw new Error("request receipt must admit its queued run");
      }
      operations.push({ kind: "check", key: keys.project(workspace.projectName), condition: projectIsLive });
      operations.push({ kind: "update", key: keys.chat(workspace.chatId), patch: row => ({ ...row, ...chatActivityFields(workspace.updatedAt) }), condition: row =>
        chatIsLive(row) && row?.ownerEmail === workspace.ownerEmail && !isExpired(row?.expiresAt, Date.now()) });
      operations.push({ kind: "put", condition: conditions.notExists,
        item: { ...keys.workspaceChild(workspace.id, "REQUEST", request.key), value: request,
          expiresAt: expiry(workspace.updatedAt) } });
    }
    for (const event of events) {
      assertChild(workspace.id, event);
      if (!run || event.runId !== run.id || !Number.isSafeInteger(event.seq) || event.seq < 1 ||
        event.seq > WORKSPACE_LIMITS.eventsPerRun || event.seq > run.lastEventSeq ||
        Buffer.byteLength(JSON.stringify(event.data)) > WORKSPACE_LIMITS.eventBytes) {
        throw new Error("invalid workspace event");
      }
      operations.push({ kind: "put", condition: conditions.notExists, item: {
        ...keys.workspaceEvent(workspace.id, event.runId, event.seq), value: event,
        expiresAt: expiry(event.createdAt),
      } });
    }
    if (delivery) operations.push({ kind: "put", condition: conditions.notExists, item: {
      ...keys.workspaceChild(workspace.id, "DELIVERY", delivery.id), value: delivery.fingerprint, expiresAt: expiry(workspace.updatedAt),
    } });
    operations.push({ kind: "put", item: { ...keys.workspaceChat(workspace.chatId), value: workspace.id,
      expiresAt: expiry(workspace.updatedAt) }, condition: conditions.existsWith("value", workspace.id) });
    await transact(operations);
  },
  async session(id, childId) { return value(await getItem(keys.workspaceChild(id, "SESSION", childId))); },
  async sandbox(id, childId) { return value(await getItem(keys.workspaceChild(id, "SANDBOX", childId))); },
  async run(id, childId) { return value(await getItem(keys.workspaceChild(id, "RUN", childId))); },
  async runs(id, limit) {
    return (await queryItems({ pk: keys.workspacePartition(id), sk: { prefix: keys.workspaceChildPrefix("RUN") },
      forward: false, limit: page(limit), notExpiredAt: expiresAtFromNow(0) })).map(row => row.value as WorkspaceRun);
  },
  async events(id, runId, afterSeq, limit) {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error("invalid workspace event cursor");
    if (afterSeq >= WORKSPACE_LIMITS.eventsPerRun) return [];
    return (await queryItems({ pk: keys.workspacePartition(id), sk: keys.workspaceEventRange(runId, afterSeq),
      limit: page(limit), notExpiredAt: expiresAtFromNow(0) })).map(row => row.value as WorkspaceEvent);
  },
  async approval(id, childId) { return value(await getItem(keys.workspaceChild(id, "APPROVAL", childId))); },
  async approvals(id, limit) {
    return (await queryItems({ pk: keys.workspacePartition(id), sk: { prefix: keys.workspaceChildPrefix("APPROVAL") },
      forward: false, limit: page(limit), notExpiredAt: expiresAtFromNow(0) })).map(row => row.value as CodingApproval);
  },
  async request(id, key) { return value(await getItem(keys.workspaceChild(id, "REQUEST", key))); },
  async delivery(id, deliveryId) { return value(await getItem(keys.workspaceChild(id, "DELIVERY", deliveryId))); },
};
