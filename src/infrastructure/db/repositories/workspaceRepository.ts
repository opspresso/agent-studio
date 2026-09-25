import type { WorkspaceRepository, WorkspaceWrite } from "@/domain/workspace/repository";
import type { Workspace, WorkspaceRun, WorkspaceEvent } from "@/domain/workspace/types";
import type { CodingApproval } from "@/domain/coding/types";
import { mayAdvanceCodingApproval, isTerminalCodingApproval } from "@/domain/coding/types";
import type { WorkspaceContinuation } from "@/domain/workspace/continuation";
import { WORKSPACE_LIMITS } from "@/domain/workspace/limits";
import { keys } from "../keys";
import { conditions, getItem, queryItems, transact, CONDITIONAL_WRITE_FAILED, TRANSACTION_CANCELLED, type Item, type TransactOp } from "../store";
import { chatActivityFields, chatIsLive } from "../chatLifecycle";
import { chatCreationItem, chatMessageItem } from "./chatRepository";
import { agentIsLive } from "../agentLifecycle";
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

function continuationItem(item: WorkspaceContinuation): Item {
  return { ...keys.workspaceChild(item.workspaceId, "CONTINUATION", item.approvalId), value: item,
    expiresAt: expiry(item.createdAt),
    ...(["pending", "waiting-ci", "running"].includes(item.status) ? {
      GSI2PK: keys.workspaceContinuationsDue(), GSI2SK: keys.workspaceDueSort(item.dueAt, `${item.workspaceId}#${item.approvalId}`),
    } : {}) };
}

function sourceChatLink(workspace: Workspace, sourceChatId: string, expectedWorkspaceId?: string): TransactOp {
  return { kind: "update", key: keys.chat(sourceChatId),
    patch: row => ({ ...row, linkedWorkspaces: { ...(row?.linkedWorkspaces as Record<string, string> | undefined), [workspace.agentName]: workspace.id } }),
    condition: row => {
      const links = (row?.linkedWorkspaces ?? {}) as Record<string, string>;
      const current = links[workspace.agentName];
      return chatIsLive(row) && row?.ownerEmail === workspace.ownerEmail && !row.workspaceId &&
        !isExpired(row.expiresAt, Date.now()) && (current === workspace.id || current === expectedWorkspaceId) &&
        (current !== undefined || Object.keys(links).length < WORKSPACE_LIMITS.linkedAgents);
    } };
}

/** Revision checks fence every child write, including terminal events and approvals. */
export const workspaceRepository: WorkspaceRepository = {
  async create(workspace, session, chat, sourceChatId) {
    assertChild(workspace.id, session);
    if (chat && (chat.chatId !== workspace.chatId || chat.ownerEmail !== workspace.ownerEmail || chat.agentName !== workspace.agentName)) throw new Error("Workspace chat scope mismatch");
    if (workspace.revision !== 0 || workspace.sessionId !== session.id || workspace.runtime !== session.runtime) throw new Error("invalid initial workspace");
    if (sourceChatId === workspace.chatId) throw new Error("Workspace cannot be its own source chat");
    await transact([
      { kind: "check", key: keys.agent(workspace.agentName), condition: agentIsLive },
      ...(chat ? [{ kind: "put" as const, item: chatCreationItem({ ...chat, workspaceId: workspace.id }), condition: conditions.notExists }] : [
      { kind: "update" as const, key: keys.chat(workspace.chatId), patch: (row: Item | null) => ({ ...row, workspaceId: workspace.id }), condition: (row: Item | null) =>
        chatIsLive(row) && row?.ownerEmail === workspace.ownerEmail &&
        row?.agentName === workspace.agentName && row?.workspaceId === undefined && row?.activeRunId === undefined &&
        !isExpired(row?.expiresAt, Date.now()) }]),
      { kind: "put", item: workspaceItem(workspace), condition: conditions.notExists },
      { kind: "put", item: { ...keys.workspaceChat(workspace.chatId), value: workspace.id,
        expiresAt: expiry(workspace.updatedAt) }, condition: conditions.notExists },
      { kind: "put", item: { ...keys.workspaceChild(workspace.id, "SESSION", session.id), value: session,
        expiresAt: expiry(session.updatedAt) }, condition: conditions.notExists },
      ...(sourceChatId ? [sourceChatLink(workspace, sourceChatId)] : []),
    ]);
  },
  async linkChat(workspace, sourceChatId, expectedWorkspaceId) {
    if (sourceChatId === workspace.chatId) throw new Error("Workspace cannot be its own source chat");
    await transact([
      { kind: "check", key: keys.workspace(workspace.id), condition: row => {
        const current = row?.value as Workspace | undefined;
        return current?.ownerEmail === workspace.ownerEmail && current.agentName === workspace.agentName &&
          !current.deleteRequestedAt && !isExpired(row?.expiresAt, Date.now());
      } },
      sourceChatLink(workspace, sourceChatId, expectedWorkspaceId),
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
        previous?.chatId === workspace.chatId && previous?.agentName === workspace.agentName &&
        previous?.sessionId === workspace.sessionId && previous?.runtime === workspace.runtime &&
        (previous?.status !== "closed" || (!previous.deleteRequestedAt && (
          (change.reopenOwner === workspace.ownerEmail && workspace.status === "active" && run?.status === "queued" && !!request) ||
          (change.reopenGitOwner === workspace.ownerEmail && workspace.status === "active" && !!workspace.activeActionId &&
            !!workspace.leaseToken && !workspace.activeRunId && !run && !request && !approval) ||
          (change.deleteOwner === workspace.ownerEmail && workspace.status === "closing" && !!workspace.deleteRequestedAt && !run && !request)
        ))) && !isExpired(row?.expiresAt, Date.now()) &&
        (!approval || mayAdvanceCodingApproval(previous!, approval)) &&
        (!previous?.deleteRequestedAt || workspace.deleteRequestedAt === previous.deleteRequestedAt);
    } }];
    for (const [kind, child] of [["SESSION", session], ["SANDBOX", sandbox], ["RUN", run], ["APPROVAL", approval]] as const) {
      if (!child) continue;
      assertChild(workspace.id, child);
      operations.push({ kind: "put", item: { ...keys.workspaceChild(workspace.id, kind, child.id), value: child,
        expiresAt: expiry(workspace.updatedAt) } });
    }
    if (approval?.sourceChatId && isTerminalCodingApproval(approval.status)) {
      const notification: WorkspaceContinuation = { workspaceId: workspace.id, approvalId: approval.id,
        chatId: approval.sourceChatId, ownerEmail: approval.requestedBy, agentName: workspace.agentName, revision: 0, status: "pending",
        createdAt: workspace.updatedAt, dueAt: workspace.updatedAt };
      // The effect result and its delivery are one transaction. Re-saving an outcome
      // must not reset a notification already claimed by a chat worker.
      operations.push({ kind: "update", key: keys.workspaceChild(workspace.id, "CONTINUATION", approval.id),
        patch: row => row ?? continuationItem(notification),
        condition: row => !row || (row.value as WorkspaceContinuation).chatId === notification.chatId });
    }
    if (request || change.reopenGitOwner) {
      operations.push({ kind: "check", key: keys.agent(workspace.agentName), condition: agentIsLive });
      operations.push({ kind: "update", key: keys.chat(workspace.chatId), patch: row => ({ ...row, ...chatActivityFields(workspace.updatedAt) }), condition: row =>
        chatIsLive(row) && row?.ownerEmail === workspace.ownerEmail && !isExpired(row?.expiresAt, Date.now()) });
    }
    if (request) {
      if (run?.id !== request.runId || run.status !== "queued" || workspace.activeRunId !== run.id) {
        throw new Error("request receipt must admit its queued run");
      }
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
  async dueContinuations(now, limit) {
    return (await queryItems({ index: "GSI2", pk: keys.workspaceContinuationsDue(), sk: keys.workspaceDueRange(now),
      limit: page(limit), notExpiredAt: expiresAtFromNow(0, Date.parse(now)) })).map(row => row.value as WorkspaceContinuation);
  },
  async continuation(id, approvalId) { return value(await getItem(keys.workspaceChild(id, "CONTINUATION", approvalId))); },
  async updateContinuation(next, expectedRevision, notice) {
    if (next.revision !== expectedRevision + 1) throw new Error("Continuation revision must advance once");
    if (notice && (notice.chatId !== next.chatId || notice.workspaceAction?.workspaceId !== next.workspaceId ||
      notice.workspaceAction.approvalId !== next.approvalId || !next.runId || next.status !== "running")) throw new Error("Invalid continuation notice");
    try {
      await transact([{ kind: "update", key: keys.workspaceChild(next.workspaceId, "CONTINUATION", next.approvalId), patch: () => continuationItem(next), condition: row => {
        const previous = row?.value as WorkspaceContinuation | undefined;
        return previous?.revision === expectedRevision && previous.chatId === next.chatId &&
          previous.ownerEmail === next.ownerEmail && previous.agentName === next.agentName && !isExpired(row?.expiresAt, Date.now());
      } }, ...(notice ? [
        { kind: "check" as const, key: keys.workspace(next.workspaceId), condition: (row: Item | null) => {
          const workspace = row?.value as Workspace | undefined;
          return workspace?.ownerEmail === next.ownerEmail && workspace.agentName === next.agentName &&
            !workspace.deleteRequestedAt && !isExpired(row?.expiresAt, Date.now());
        } },
        { kind: "check" as const, key: keys.chat(next.chatId), condition: (row: Item | null) => chatIsLive(row) &&
          row?.ownerEmail === next.ownerEmail && row?.activeRunId === next.runId &&
          !isExpired(row?.expiresAt, Date.now()) && (row?.linkedWorkspaces as Record<string, string> | undefined)?.[next.agentName] === next.workspaceId },
        { kind: "put" as const, item: chatMessageItem(notice), condition: conditions.notExists },
      ] : [])]);
      return true;
    } catch (error) {
      if (error instanceof Error && [CONDITIONAL_WRITE_FAILED, TRANSACTION_CANCELLED].includes(error.name)) return false;
      throw error;
    }
  },
};
