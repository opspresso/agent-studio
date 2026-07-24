/**
 * Shared CRUD core for the registry slices (MCP servers, external agents,
 * skills). Owns the name-keyed lifecycle and its error semantics — missing →
 * NotFoundError, duplicate create → ConflictError — so routes map everything
 * through `apiError`. Slice-specific dispatch methods (testConnection,
 * sendMessage) stay in their slices, layered on top.
 */

import { ConflictError, NotFoundError, ValidationError } from "@/application/errors";
import { assertPublicUrl, SsrfError } from "@/infrastructure/net/ssrfGuard";

/** Minimal repository shape shared by the registry slices. */
export interface RegistryRepository<T> {
  get(name: string): Promise<T | null>;
  list(): Promise<T[]>;
  create(entity: T): Promise<void>;
  update(entity: T): Promise<void>;
  delete(name: string): Promise<void>;
}

/** SSRF policy at the write boundary: a blocked URL is invalid input (400). */
export async function assertAllowedUrl(url: string): Promise<void> {
  try {
    await assertPublicUrl(url);
  } catch (error) {
    throw new ValidationError(error instanceof SsrfError ? error.message : "Blocked URL");
  }
}

export interface RegistryUseCasesOptions<T extends { name: string }, C extends { name: string }, U> {
  /** Entity label used in error messages, e.g. "MCP server". */
  label: string;
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
  /** Throws {@link NotFoundError} when no entity with that name exists. */
  remove(name: string): Promise<void>;
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
      if (await opts.repo.get(input.name)) {
        throw new ConflictError(`${opts.label} "${input.name}" already exists`);
      }
      const entity = await opts.build(input, new Date().toISOString());
      try {
        await opts.repo.create(entity);
      } catch (error) {
        if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
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
        if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
          throw new NotFoundError(`${opts.label} not found: ${name}`);
        }
        throw error;
      }
      return view(updated);
    },

    async remove(name) {
      await require(name);
      try {
        await opts.repo.delete(name);
      } catch (error) {
        if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
          throw new NotFoundError(`${opts.label} not found: ${name}`);
        }
        throw error;
      }
    },
  };
}
