import { keys } from "@/infrastructure/db/keys";
import {
  conditions,
  deleteIndexPartition,
  deleteItem,
  deletePartition,
  getItem,
  putItem,
  queryItems,
  transact,
  updateItem,
} from "@/infrastructure/db/store";
import type { ProjectRepository } from "@/domain/project/repository";
import type { Project, ProjectApiToken } from "@/domain/project/types";
import { boundedPageLimit } from "@/shared/pageLimit";
import { projectIsLive, putProjectItem } from "@/infrastructure/db/projectLifecycle";

const ENTITY_TYPE = "PROJECT";
const TOMBSTONE_ENTITY_TYPE = "PROJECT_TOMBSTONE";

function toItem(project: Project): Record<string, unknown> {
  const key = keys.project(project.name);
  return {
    ...project,
    PK: key.PK,
    SK: key.SK,
    GSI1PK: keys.typePartition("PROJECT"),
    GSI1SK: project.name,
    entityType: ENTITY_TYPE,
  };
}

function fromItem(item: Record<string, unknown>): Project {
  return {
    name: item.name as string,
    displayName: item.displayName as string,
    description: item.description as string,
    projectType: item.projectType as Project["projectType"],
    ownerEmail: item.ownerEmail as string,
    visibility: item.visibility as Project["visibility"] | undefined,
    memberEmails: item.memberEmails as string[] | undefined,
    departmentCode: item.departmentCode as string | undefined,
    publishedVersion: item.publishedVersion as string | undefined,
    slack: item.slack as Project["slack"] | undefined,
    telegram: item.telegram as Project["telegram"] | undefined,
    teams: item.teams as Project["teams"] | undefined,
    costLimits: item.costLimits as Project["costLimits"] | undefined,
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
  };
}

/** The live, unmodified project row a write may build on. */
function liveAt(expectedUpdatedAt: string) {
  return (row: Record<string, unknown> | null): boolean =>
    projectIsLive(row) && row?.updatedAt === expectedUpdatedAt;
}

export const projectRepository: ProjectRepository = {
  async get(name: string): Promise<Project | null> {
    const item = await getItem(keys.project(name));
    return item && projectIsLive(item) ? fromItem(item) : null;
  },

  async list(limit, after): Promise<Project[]> {
    const items = await queryItems({
      index: "GSI1",
      pk: keys.typePartition("PROJECT"),
      limit: boundedPageLimit(limit),
      ...(after ? { after } : {}),
    });
    return items.filter(projectIsLive).map(fromItem);
  },

  async create(project: Project): Promise<void> {
    await putItem(toItem(project), conditions.notExists);
  },

  async update(project: Project, expectedUpdatedAt: string): Promise<void> {
    await putItem(toItem(project), liveAt(expectedUpdatedAt));
  },

  async publish(
    project: Project,
    versionName: string,
    expectedUpdatedAt: string,
  ): Promise<void> {
    await transact([
      { kind: "check", key: keys.version(project.name, versionName), condition: conditions.exists },
      { kind: "put", item: toItem(project), condition: liveAt(expectedUpdatedAt) },
    ]);
  },

  /**
   * Cascade delete: all project-owned rows, then replace META with a minimal
   * tombstone. A project name is an external identity and remains reserved;
   * reusing it would attach retained artifacts and chats to a different owner.
   */
  async delete(name: string): Promise<void> {
    await updateItem(
      keys.project(name),
      (row) => {
        const { GSI1PK: _pk, GSI1SK: _sk, ...rest } = row ?? {};
        void _pk, _sk;
        return { ...rest, deletingAt: row?.deletingAt ?? new Date().toISOString() };
      },
      conditions.exists,
    );
    const partition = keys.projectPartition(name);
    await deletePartition(keys.usage(name, "").PK);
    // Every trace row carries the project's index partition, so this is the
    // cascade for them; the references in the project partition go below.
    await deleteIndexPartition("GSI1", keys.traceProjectPartition(name));
    await deletePartition(partition, { keep: [keys.project(name).SK] });
    await updateItem(
      keys.project(name),
      (row) => ({
        entityType: TOMBSTONE_ENTITY_TYPE,
        name,
        deletedAt: row?.deletingAt,
      }),
      (row) => row !== null && row.deletingAt !== undefined,
    );
  },

  async getApiToken(name: string): Promise<ProjectApiToken | null> {
    const item = await getItem(keys.projectApiToken(name));
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

  async setApiToken(name: string, token: ProjectApiToken): Promise<void> {
    await putProjectItem(name, {
      ...keys.projectApiToken(name),
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
    await deleteItem(keys.projectApiToken(name));
  },
};
