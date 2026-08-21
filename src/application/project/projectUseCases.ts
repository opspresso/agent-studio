import type { ProjectRepository } from "@/domain/project/repository";
import type { CostLimits, Project, ProjectType, ProjectVisibility } from "@/domain/project/types";
import { mayAccessProject, normalizeMemberEmails } from "@/domain/project/access";
import { ConflictError, ForbiddenError, NotFoundError, isConditionalWriteFailure } from "@/application/errors";
import { nextUpdatedAt } from "./timestamps";
import { log } from "@/shared/logger";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";

/** The admin-list reader the write override consults. See {@link setAdminCheck}. */
type AdminCheck = (userEmail: string) => Promise<boolean>;

/**
 * Deny until wired: a composition that forgot the check keeps plain owner-only
 * writes — the same posture as a deployment with no admin list — rather than
 * opening every project or crashing.
 */
let configuredAdminCheck: AdminCheck = async () => false;

/**
 * Wire the admin-list reader the override consults. Called once by the
 * composition root. Pushed in rather than imported, because the reader lives in
 * `lib/runtime-settings` on top of the settings store — a static import here
 * would pull the DynamoDB client into the application layer through the side
 * door. And pushed once rather than threaded through call sites, because a
 * caller that forgot the argument would silently narrow the rule back to
 * owner-only for its path alone.
 */
export function setAdminCheck(check: AdminCheck): void {
  configuredAdminCheck = check;
}

export interface CreateProjectInput {
  name: string;
  displayName: string;
  description: string;
  projectType: ProjectType;
  ownerEmail: string;
  departmentCode?: string;
  /**
   * Not offered by the console's create form (a new project starts public, as
   * every project always has); a clone passes the source's, so cloning a
   * private project cannot quietly republish its prompt to the whole org.
   */
  visibility?: ProjectVisibility;
}

export interface UpdateProjectInput {
  displayName?: string;
  description?: string;
  departmentCode?: string;
  /** Replaces the stored guards; `null` removes them. Absent leaves them alone. */
  costLimits?: CostLimits | null;
  visibility?: ProjectVisibility;
  /** Replaces the invite list; absent leaves it alone. Normalized on write. */
  memberEmails?: string[];
}

export function listProjects(repo: ProjectRepository): Promise<Project[]> {
  return repo.list();
}

/**
 * The projects `userEmail` may see: everything public, plus the private ones
 * they own or are invited to — or everything, for an admin, who could reach
 * each one through the write override anyway and administers the catalog as a
 * whole. One admin check for the whole list, not one per row.
 */
export async function listAccessibleProjects(
  repo: ProjectRepository,
  userEmail: string,
): Promise<Project[]> {
  const projects = await repo.list();
  if (await isAdminOverride(userEmail)) {
    return projects;
  }
  return projects.filter((project) => mayAccessProject(project, userEmail));
}

export async function getProject(repo: ProjectRepository, name: string): Promise<Project> {
  const project = await repo.get(name);
  if (!project) {
    throw new NotFoundError(`Project "${name}" not found`);
  }
  return project;
}

/**
 * Load a project and assert `userEmail` may write it. Projects are a shared
 * catalog — anyone the visibility admits may read and run them
 * ({@link assertProjectAccessible}); writing is for the owner and for admins,
 * on either visibility.
 *
 * Named for what it checks, not for the owner alone: it is bound at twenty-odd
 * call sites, and while it asserted ownership the name was the documentation.
 * Anything that ever needs *ownership* specifically — attributing a quota,
 * choosing whose credentials to dispatch with, deciding whom to notify — must
 * read `project.ownerEmail` and not reach for this.
 *
 * The admin case is checked here rather than threaded through those call sites
 * as a flag: the rule is "owner or admin", and a flag any one caller forgot to
 * pass would silently narrow it back to owner-only for that path alone.
 * The wired check ({@link setAdminCheck}) reads the effective admin list, so
 * demoting an admin on the settings page takes effect without a redeploy — and
 * it is the *configured* check, so a deployment with no admin list keeps plain
 * owner-only writes rather than opening every project to everyone.
 */
export async function assertProjectWritable(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
): Promise<Project> {
  const project = await getProject(repo, name);
  if (project.ownerEmail === userEmail) {
    return project;
  }
  if (await isAdminOverride(userEmail)) {
    // The owner cannot see this happen from the data — a deleted project takes
    // the row that would have named who deleted it — so the override is the
    // thing worth recording, not the eventual write. Recorded twice on purpose:
    // the row is what a later question can query, the line is what survives the
    // audit store itself being unavailable.
    log.warn(
      "authz",
      `admin ${userEmail} is acting on project "${name}" owned by ${project.ownerEmail}`,
    );
    await recordAudit({
      actorEmail: userEmail,
      action: "project.admin-override",
      target: auditTarget("project", name),
      detail: `owned by ${project.ownerEmail}`,
    });
    return project;
  }
  throw new ForbiddenError(`You do not have permission to modify project "${name}"`);
}

/**
 * Load a project and assert `userEmail` may access it — the read-and-run
 * sibling of {@link assertProjectWritable}, asked by every console surface
 * that shows or runs a project on a person's behalf. The domain predicate
 * (`mayAccessProject`) is the rule; this adds the admin override, allowed for
 * the same reason admins may write: they administer the catalog. Unlike the
 * write override it is logged but not audited — a read changes nothing, so
 * there is no later question only an audit row could answer.
 *
 * API-token and integration paths deliberately never come here: a token is
 * the project's own credential, and a bot the owner wired to a surface was
 * pointed there by the owner. The person-facing gate for those surfaces is
 * their own (the Slack pipeline checks the asker's email itself).
 */
export async function assertProjectAccessible(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
): Promise<Project> {
  const project = await getProject(repo, name);
  if (await userMayAccessProject(project, userEmail)) {
    return project;
  }
  throw new ForbiddenError(`Project "${name}" is private`);
}

/**
 * The access predicate with the admin override folded in, for slices that
 * already hold the project row — the chat use cases and the messaging
 * pipeline, which load the project for the run they are about to start and
 * must not read it twice just to ask this. Everything else goes through
 * {@link assertProjectAccessible}.
 */
export async function userMayAccessProject(project: Project, userEmail: string): Promise<boolean> {
  if (mayAccessProject(project, userEmail)) {
    return true;
  }
  if (await isAdminOverride(userEmail)) {
    log.warn(
      "authz",
      `admin ${userEmail} is accessing private project "${project.name}" owned by ${project.ownerEmail}`,
    );
    return true;
  }
  return false;
}

/**
 * The admin override, resolved so that losing the settings store denies rather
 * than throws.
 *
 * Only a non-owner reaches this, and for a non-owner on a deployment with no
 * admin list the answer is "no" without any I/O at all. Letting a settings read
 * failure escape would turn the deterministic 403 that path has always returned
 * into a 500, so an outage would change *which* error an unauthorized caller
 * sees. Failing closed keeps the denial.
 */
async function isAdminOverride(userEmail: string): Promise<boolean> {
  try {
    return await configuredAdminCheck(userEmail);
  } catch (error) {
    log.error("authz", "admin list unavailable; denying the override", error);
    return false;
  }
}

export async function createProject(
  repo: ProjectRepository,
  input: CreateProjectInput,
): Promise<Project> {
  const existing = await repo.get(input.name);
  if (existing) {
    throw new ConflictError(`Project "${input.name}" already exists`);
  }

  const now = new Date().toISOString();
  const project: Project = {
    name: input.name,
    displayName: input.displayName,
    description: input.description,
    projectType: input.projectType,
    ownerEmail: input.ownerEmail,
    departmentCode: input.departmentCode,
    ...(input.visibility ? { visibility: input.visibility } : {}),
    createdAt: now,
    updatedAt: now,
  };
  try {
    await repo.create(project);
  } catch (error) {
    // The repository's conditional put loses a create race the pre-check missed.
    if (isConditionalWriteFailure(error)) {
      throw new ConflictError(`Project "${input.name}" already exists`);
    }
    throw error;
  }
  return project;
}

export async function updateProject(
  repo: ProjectRepository,
  name: string,
  input: UpdateProjectInput,
  userEmail: string,
): Promise<Project> {
  const existing = await assertProjectWritable(repo, name, userEmail);
  const updated: Project = {
    ...existing,
    displayName: input.displayName ?? existing.displayName,
    description: input.description ?? existing.description,
    departmentCode: input.departmentCode ?? existing.departmentCode,
    // Three-state on purpose: absent keeps, `null` clears, an object replaces.
    // `??` alone cannot express the clear, and a spread merge could not remove
    // one threshold while keeping the other.
    ...(input.costLimits === undefined
      ? {}
      : input.costLimits === null
        ? { costLimits: undefined }
        : { costLimits: input.costLimits }),
    ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    ...(input.memberEmails === undefined
      ? {}
      : { memberEmails: normalizeMemberEmails(input.memberEmails, existing.ownerEmail) }),
    updatedAt: nextUpdatedAt(existing.updatedAt),
  };
  try {
    await repo.update(updated, existing.updatedAt);
  } catch (error) {
    if (isConditionalWriteFailure(error)) {
      throw new ConflictError(`Project "${name}" was modified by another request`);
    }
    throw error;
  }
  return updated;
}

/**
 * What has to happen outside the table before a project's rows go: today, the
 * project's Telegram bot webhook, whose token is on the row about to be deleted.
 * Injected by the composition root; the project slice does not know Telegram.
 */
export type BeforeProjectDelete = (project: Project) => Promise<void>;

/** Delete a project. The repository cascades version and usage cleanup. */
export async function deleteProject(
  repo: ProjectRepository,
  name: string,
  userEmail: string,
  beforeDelete?: BeforeProjectDelete,
): Promise<void> {
  const project = await assertProjectWritable(repo, name, userEmail);
  // Before the row goes, while what it holds can still be acted on — and best
  // effort by contract: nothing the hook does may make a project undeletable.
  // The hook already catches its own network failure; this catches the rest
  // (a credential that no longer decrypts is the case that would otherwise
  // pin the project forever).
  try {
    await beforeDelete?.(project);
  } catch (error) {
    log.warn("project", `pre-delete hook failed for ${name}; deleting anyway`, error);
  }
  await repo.delete(name);
  // After the delete, and the one record that survives it: the cascade takes
  // every row that could otherwise have said who the project belonged to.
  await recordAudit({
    actorEmail: userEmail,
    action: "project.delete",
    target: auditTarget("project", name),
    detail: `owned by ${project.ownerEmail}`,
  });
}

/**
 * The slice bound to its repository, composed once by the composition root.
 *
 * **Which form to use is not a preference.** A route handler takes the bound
 * object; a use case that already holds the repository calls the function
 * directly. The functions above are the implementation, and they stay exported
 * because `triggerUseCases`, `mcpAuthUseCases` and `projectSlack` each hold a
 * `ProjectRepository` of their own already — passing it to a sibling inside the
 * same layer is ordinary, and handing those three a second object holding the
 * repository they were injected with would be the indirection, not the fix.
 *
 * What was not ordinary is that the *presentation* layer supplied it. Twenty
 * route handlers imported `projectRepository` from the composition root to hand
 * it back to a use case, which made each of them a wiring site — while
 * `tests/architecture.test.ts` declares exactly four and the mcp, skill, agent
 * and trigger slices had none of this. `tests/architecture.test.ts` now keeps
 * `projectRepository` and `versionRepository` out of `src/app` entirely, so the
 * split above is enforced rather than remembered.
 */
export interface ProjectUseCases {
  list(): Promise<Project[]>;
  /** See {@link listAccessibleProjects} — what this person's console may show. */
  listAccessible(userEmail: string): Promise<Project[]>;
  get(name: string): Promise<Project>;
  /** See {@link assertProjectAccessible} — visibility, membership, admin override. */
  assertAccessible(name: string, userEmail: string): Promise<Project>;
  /** See {@link assertProjectWritable} — owner or admin, and the override is recorded. */
  assertWritable(name: string, userEmail: string): Promise<Project>;
  create(input: CreateProjectInput): Promise<Project>;
  update(name: string, input: UpdateProjectInput, userEmail: string): Promise<Project>;
  remove(name: string, userEmail: string): Promise<void>;
}

export function createProjectUseCases(
  projects: ProjectRepository,
  hooks: { beforeDelete?: BeforeProjectDelete } = {},
): ProjectUseCases {
  return {
    list: () => listProjects(projects),
    listAccessible: (userEmail) => listAccessibleProjects(projects, userEmail),
    get: (name) => getProject(projects, name),
    assertAccessible: (name, userEmail) => assertProjectAccessible(projects, name, userEmail),
    assertWritable: (name, userEmail) => assertProjectWritable(projects, name, userEmail),
    create: (input) => createProject(projects, input),
    update: (name, input, userEmail) => updateProject(projects, name, input, userEmail),
    remove: (name, userEmail) => deleteProject(projects, name, userEmail, hooks.beforeDelete),
  };
}
