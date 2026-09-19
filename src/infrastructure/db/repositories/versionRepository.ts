import { keys } from "@/infrastructure/db/keys";
import { conditions, getItem, queryItems, transact } from "@/infrastructure/db/store";
import type { VersionRepository } from "@/domain/project/repository";
import type { Version } from "@/domain/project/types";
import { boundedPageLimit } from "@/shared/pageLimit";
import { projectIsLive } from "@/infrastructure/db/projectLifecycle";
import { toMcpBindings } from "@/infrastructure/db/projectConfiguration";

const ENTITY_TYPE = "VERSION";
const PUBLISHED = "published";

function toItem(version: Version): Record<string, unknown> {
  const key = keys.version(version.projectName, version.versionName);
  return {
    ...version,
    PK: key.PK,
    SK: key.SK,
    entityType: ENTITY_TYPE,
  };
}

function fromItem(item: Record<string, unknown>): Version {
  return {
    projectName: item.projectName as string,
    versionName: item.versionName as string,
    systemPrompt: item.systemPrompt as string,
    userPromptTemplate: item.userPromptTemplate as string,
    model: item.model as string,
    fallbackModel: item.fallbackModel as string | undefined,
    parameters: item.parameters as Version["parameters"],
    mcpList: toMcpBindings(item.mcpList),
    skillList: (item.skillList as string[] | undefined) ?? [],
    subagentList: (item.subagentList as Version["subagentList"] | undefined) ?? [],
    maxTurn: item.maxTurn as number | undefined,
    createdAt: item.createdAt as string,
  };
}

/** Resolve the concrete version name a project's "published" pointer refers to. */
async function resolvePublished(projectName: string): Promise<string | null> {
  const project = await getItem(keys.project(projectName));
  const pointer = project?.publishedVersion;
  return typeof pointer === "string" ? pointer : null;
}

export const versionRepository: VersionRepository = {
  async get(projectName: string, versionName: string): Promise<Version | null> {
    let resolved = versionName;
    if (versionName === PUBLISHED) {
      const pointer = await resolvePublished(projectName);
      if (!pointer) {
        return null;
      }
      resolved = pointer;
    }
    const item = await getItem(keys.version(projectName, resolved));
    return item ? fromItem(item) : null;
  },

  async list(projectName, limit, after): Promise<Version[]> {
    const items = await queryItems({
      pk: keys.projectPartition(projectName),
      sk: { prefix: keys.versionPrefix() },
      limit: boundedPageLimit(limit),
      ...(after ? { after: keys.version(projectName, after).SK } : {}),
    });
    return items.map((item) => {
      const version = fromItem(item);
      if (
        version.projectName !== projectName ||
        keys.version(projectName, version.versionName).SK !== item.SK
      ) {
        throw new Error("version row identity does not match its key");
      }
      return version;
    });
  },

  async put(version: Version): Promise<void> {
    await transact([
      { kind: "check", key: keys.project(version.projectName), condition: projectIsLive },
      { kind: "put", item: toItem(version), condition: conditions.exists },
    ]);
  },

  async create(version: Version): Promise<void> {
    await transact([
      { kind: "check", key: keys.project(version.projectName), condition: projectIsLive },
      { kind: "put", item: toItem(version), condition: conditions.notExists },
    ]);
  },

  async delete(
    projectName: string,
    versionName: string,
    expectedProjectUpdatedAt: string,
  ): Promise<void> {
    await transact([
      {
        kind: "check",
        key: keys.project(projectName),
        condition: (row) =>
          projectIsLive(row) &&
          row?.updatedAt === expectedProjectUpdatedAt &&
          (row?.publishedVersion === undefined || row?.publishedVersion !== versionName),
      },
      { kind: "delete", key: keys.version(projectName, versionName), condition: conditions.exists },
    ]);
  },
};
