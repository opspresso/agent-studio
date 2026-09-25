import { keys } from "@/infrastructure/db/keys";
import {
  conditions,
  deleteIndexPartition,
  deleteItem,
  deletePartition,
  getItem,
  putItem,
  queryItems,
  updateItem,
} from "@/infrastructure/db/store";
import type { AgentRepository } from "@/domain/agent/repository";
import type { Agent, AgentApiToken } from "@/domain/agent/types";
import { boundedPageLimit } from "@/shared/pageLimit";
import { agentIsLive, putAgentItem } from "@/infrastructure/db/agentLifecycle";
import { readAgentConfiguration } from "@/infrastructure/db/agentConfiguration";

const ENTITY_TYPE = "AGENT";
const TOMBSTONE_ENTITY_TYPE = "AGENT_TOMBSTONE";

function toItem(agent: Agent): Record<string, unknown> {
  const key = keys.agent(agent.name);
  return {
    ...agent,
    PK: key.PK,
    SK: key.SK,
    GSI1PK: keys.typePartition("AGENT"),
    GSI1SK: agent.name,
    entityType: ENTITY_TYPE,
  };
}

function requiredString(item: Record<string, unknown>, field: string): string {
  const value = item[field];
  if (typeof value !== "string" || value === "") {
    throw new Error(`agent row has invalid ${field}`);
  }
  return value;
}

function visibility(value: unknown): Agent["visibility"] {
  if (value === undefined || value === "public" || value === "private") {
    return value;
  }
  throw new Error("agent row has invalid agent visibility");
}

function memberEmails(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value) && value.every((email) => typeof email === "string")) {
    return value;
  }
  throw new Error("agent row has invalid memberEmails");
}

function fromItem(item: Record<string, unknown>): Agent {
  return {
    name: requiredString(item, "name"),
    displayName: requiredString(item, "displayName"),
    description: typeof item.description === "string" ? item.description : "",
    ownerEmail: requiredString(item, "ownerEmail"),
    visibility: visibility(item.visibility),
    memberEmails: memberEmails(item.memberEmails),
    departmentCode: item.departmentCode as string | undefined,
    ...(item.configuration === undefined ? {} : {
      configuration: readAgentConfiguration(item.configuration, requiredString(item, "name")),
    }),
    slack: item.slack as Agent["slack"] | undefined,
    telegram: item.telegram as Agent["telegram"] | undefined,
    teams: item.teams as Agent["teams"] | undefined,
    costLimits: item.costLimits as Agent["costLimits"] | undefined,
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
  };
}

/** The live, unmodified agent row a write may build on. */
function liveAt(expectedUpdatedAt: string) {
  return (row: Record<string, unknown> | null): boolean =>
    agentIsLive(row) && row?.updatedAt === expectedUpdatedAt;
}

export const agentRepository: AgentRepository = {
  async get(name: string, options): Promise<Agent | null> {
    const item = await getItem(keys.agent(name));
    if (!item) {
      return null;
    }
    const readable =
      agentIsLive(item) ||
      (options?.includeDeleting === true &&
        item.entityType === ENTITY_TYPE &&
        typeof item.deletingAt === "string");
    return readable ? fromItem(item) : null;
  },

  /**
   * A page is filled rather than filtered down to whatever survives.
   *
   * `listAgents` walks these pages and stops on a short one, so a page that
   * dropped a row would read as the end of the catalogue and silently hide
   * every agent after it. A row being deleted leaves the index the moment it
   * is marked — the mark strips its GSI keys — so today the filter drops
   * nothing; the loop is what keeps "a short page means the end" true whatever
   * a row turns out to be.
   */
  async list(limit, after): Promise<Agent[]> {
    const wanted = boundedPageLimit(limit);
    const agents: Agent[] = [];
    let cursor = after;
    while (agents.length < wanted) {
      const readLimit = wanted - agents.length;
      const items = await queryItems({
        index: "GSI1",
        pk: keys.typePartition("AGENT"),
        limit: readLimit,
        ...(cursor ? { after: cursor } : {}),
      });
      agents.push(...items.filter(agentIsLive).map(fromItem));
      if (items.length < readLimit) {
        break;
      }
      cursor = String(items.at(-1)!.GSI1SK);
    }
    return agents;
  },

  async create(agent: Agent): Promise<void> {
    await putItem(toItem(agent), conditions.notExists);
  },

  async update(agent: Agent, expectedUpdatedAt: string): Promise<void> {
    await putItem(toItem(agent), liveAt(expectedUpdatedAt));
  },

  /**
   * Cascade delete: all agent-owned rows, then replace META with a minimal
   * tombstone. An agent name is an external identity and remains reserved;
   * reusing it would attach retained artifacts and chats to a different owner.
   */
  async delete(name: string): Promise<void> {
    await updateItem(
      keys.agent(name),
      (row) => {
        const { GSI1PK: _pk, GSI1SK: _sk, ...rest } = row ?? {};
        void _pk, _sk;
        return { ...rest, deletingAt: row?.deletingAt ?? new Date().toISOString() };
      },
      conditions.exists,
    );
    const partition = keys.agentPartition(name);
    await deletePartition(keys.usage(name, "").PK);
    // Every trace row carries the agent's index partition, so this is the
    // cascade for them; the references in the agent partition go below.
    await deleteIndexPartition("GSI1", keys.traceAgentPartition(name));
    await deletePartition(partition, { keep: [keys.agent(name).SK] });
    await updateItem(
      keys.agent(name),
      (row) => ({
        entityType: TOMBSTONE_ENTITY_TYPE,
        name,
        deletedAt: row?.deletingAt,
      }),
      (row) => row !== null && row.deletingAt !== undefined,
    );
  },

  async getApiToken(name: string): Promise<AgentApiToken | null> {
    const item = await getItem(keys.agentApiToken(name));
    if (!item) {
      return null;
    }
    // One of `token` (encrypted, revealable) or `tokenHash` (legacy) is set.
    return {
      ...(typeof item.token === "string" ? { token: item.token } : {}),
      ...(typeof item.tokenHash === "string" ? { tokenHash: item.tokenHash } : {}),
      masked: item.masked as string | undefined,
      createdAt: item.createdAt as string,
    };
  },

  async setApiToken(name: string, token: AgentApiToken): Promise<void> {
    await putAgentItem(name, {
      ...keys.agentApiToken(name),
      entityType: "APITOKEN",
      // Written as one whole item, so regenerating an encrypted token over a
      // legacy hashed one leaves no stale `tokenHash` behind.
      ...(token.token !== undefined ? { token: token.token } : {}),
      ...(token.tokenHash !== undefined ? { tokenHash: token.tokenHash } : {}),
      masked: token.masked,
      createdAt: token.createdAt,
    });
  },

  async deleteApiToken(name: string): Promise<void> {
    await deleteItem(keys.agentApiToken(name));
  },
};
