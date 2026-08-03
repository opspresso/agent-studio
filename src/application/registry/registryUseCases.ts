/**
 * Shared CRUD core for the registry slices (MCP servers, external agents,
 * skills). Owns the name-keyed lifecycle and its error semantics — missing →
 * NotFoundError, duplicate create → ConflictError — so routes map everything
 * through `apiError`. Slice-specific dispatch methods (testConnection,
 * sendMessage) stay in their slices, layered on top.
 */

import { ConflictError, NotFoundError, ValidationError, isConditionalWriteFailure } from "@/application/errors";
import { BlockedUrlError, type UrlPolicy } from "@/domain/security/urlPolicy";
import { isSlug, SLUG_RULE } from "@/shared/slug";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";

/** Minimal repository shape shared by the registry slices. */
export interface RegistryRepository<T> {
  get(name: string): Promise<T | null>;
  list(): Promise<T[]>;
  create(entity: T): Promise<void>;
  update(entity: T): Promise<void>;
  delete(name: string): Promise<void>;
}

/** SSRF policy at the write boundary: a blocked URL is invalid input (400). */
export async function assertAllowedUrl(policy: UrlPolicy, url: string): Promise<void> {
  try {
    await policy.assertAllowed(url);
  } catch (error) {
    throw new ValidationError(error instanceof BlockedUrlError ? error.message : "Blocked URL");
  }
}

export interface RegistryUseCasesOptions<T extends { name: string }, C extends { name: string }, U> {
  /** Entity label used in error messages, e.g. "MCP server". */
  label: string;
  /** Slug the audit row addresses this kind by, e.g. "mcp". */
  auditKind: string;
  repo: RegistryRepository<T>;
  /** Build a new entity from create input (timestamp supplied). */
  build(input: C, now: string): T | Promise<T>;
  /** Apply an update patch to an existing entity (timestamp supplied). */
  apply(existing: T, patch: U, now: string): T | Promise<T>;
  /** Client-safe projection applied to every returned entity. */
  view?(entity: T): T;
}

export interface RegistryUseCases<T, C, U> {
  list(): Promise<T[]>;
  /** Throws {@link NotFoundError} when no entity with that name exists. */
  get(name: string): Promise<T>;
  /** Throws {@link ConflictError} when the name is already taken. */
  create(input: C): Promise<T>;
  /** Throws {@link NotFoundError} when no entity with that name exists. */
  update(name: string, patch: U): Promise<T>;
  /**
   * Throws {@link NotFoundError} when no entity with that name exists.
   *
   * `actorEmail` is a parameter rather than something the routes record for
   * themselves: a registry entry is shared, its deletion takes the row that
   * would have said anything about it, and three routes each remembering to
   * write the same audit line is the copy this core exists to prevent.
   */
  remove(name: string, actorEmail: string): Promise<void>;
}

export function createRegistryUseCases<
  T extends { name: string },
  C extends { name: string },
  U,
>(opts: RegistryUseCasesOptions<T, C, U>): RegistryUseCases<T, C, U> {
  const view = opts.view ?? ((entity: T) => entity);

  async function require(name: string): Promise<T> {
    const existing = await opts.repo.get(name);
    if (!existing) {
      throw new NotFoundError(`${opts.label} not found: ${name}`);
    }
    return existing;
  }

  return {
    async list() {
      return (await opts.repo.list()).map(view);
    },

    async get(name) {
      return view(await require(name));
    },

    async create(input) {
      // Checked here rather than only in the route schemas, because this is the
      // one door every path goes through — an API body, a repo sync, a future
      // caller nobody has written yet. A name that got past would be stored and
      // then be unreadable: `parseName` refuses it on the way back out, so the
      // row exists and answers 404.
      if (!isSlug(input.name)) {
        throw new ValidationError(`${opts.label} name ${SLUG_RULE}`);
      }
      if (await opts.repo.get(input.name)) {
        throw new ConflictError(`${opts.label} "${input.name}" already exists`);
      }
      const entity = await opts.build(input, new Date().toISOString());
      try {
        await opts.repo.create(entity);
      } catch (error) {
        if (isConditionalWriteFailure(error)) {
          throw new ConflictError(`${opts.label} "${input.name}" already exists`);
        }
        throw error;
      }
      return view(entity);
    },

    async update(name, patch) {
      const existing = await require(name);
      const updated = await opts.apply(existing, patch, new Date().toISOString());
      try {
        await opts.repo.update(updated);
      } catch (error) {
        if (isConditionalWriteFailure(error)) {
          throw new NotFoundError(`${opts.label} not found: ${name}`);
        }
        throw error;
      }
      return view(updated);
    },

    async remove(name, actorEmail) {
      await require(name);
      try {
        await opts.repo.delete(name);
      } catch (error) {
        if (isConditionalWriteFailure(error)) {
          throw new NotFoundError(`${opts.label} not found: ${name}`);
        }
        throw error;
      }
      await recordAudit({
        actorEmail,
        action: "registry.delete",
        target: auditTarget(opts.auditKind, name),
      });
    },
  };
}
