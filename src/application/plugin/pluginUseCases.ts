import { NotFoundError } from "@/application/errors";
import type { PluginRepository } from "@/domain/plugin/repository";
import type { Plugin } from "@/domain/plugin/types";
import { auditTarget, recordAudit } from "@/application/audit/recordAudit";

/**
 * The plugin slice. Deliberately not `createRegistryUseCases`: that factory's
 * `create` enforces the registry slug, which a plugin name legally violates
 * (periods), and a plugin is never created from the console anyway — the sync
 * is its only writer. What remains is reading, and the one mutation that must
 * leave a trace.
 */
export interface PluginUseCases {
  list(): Promise<Plugin[]>;
  /** Throws {@link NotFoundError} when no plugin with that name is installed. */
  get(name: string): Promise<Plugin>;
  /**
   * Throws {@link NotFoundError} when no plugin with that name is installed.
   * Removes only the row — the plugin's components stay registered and surface
   * individually as orphans on the next sync, each its own decision.
   */
  remove(name: string, actorEmail: string): Promise<void>;
}

export function createPluginUseCases(repo: PluginRepository): PluginUseCases {
  return {
    async list() {
      return repo.list();
    },

    async get(name) {
      const existing = await repo.get(name);
      if (!existing) {
        throw new NotFoundError(`Plugin not found: ${name}`);
      }
      return existing;
    },

    async remove(name, actorEmail) {
      const existing = await repo.get(name);
      if (!existing) {
        throw new NotFoundError(`Plugin not found: ${name}`);
      }
      await repo.delete(name);
      await recordAudit({
        actorEmail,
        action: "registry.delete",
        target: auditTarget("plugin", name),
      });
    },
  };
}
