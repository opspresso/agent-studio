import type { ExternalAgentRepository } from "@/domain/agent/repository";
import type { ExternalAgent } from "@/domain/agent/types";
import { createKeyedRepository } from "../keyedRepository";
import { keys } from "../keys";

const ENTITY_TYPE = "AGENT" as const;

function fromItem(item: Record<string, unknown>): ExternalAgent {
  return {
    name: item.name as string,
    url: item.url as string,
    description: item.description as string,
    headers: (item.headers as Record<string, string> | undefined) ?? {},
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
  };
}

function toItem(agent: ExternalAgent): Record<string, unknown> {
  return {
    ...keys.externalAgent(agent.name),
    GSI1PK: keys.typePartition(ENTITY_TYPE),
    GSI1SK: agent.name,
    entityType: ENTITY_TYPE,
    name: agent.name,
    url: agent.url,
    description: agent.description,
    headers: agent.headers,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

export const externalAgentRepository: ExternalAgentRepository = createKeyedRepository<ExternalAgent>({
  entityType: ENTITY_TYPE,
  key: keys.externalAgent,
  toItem,
  fromItem,
});
