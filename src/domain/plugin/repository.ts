import type { Plugin } from "./types";

export interface PluginRepository {
  get(name: string): Promise<Plugin | null>;
  list(): Promise<Plugin[]>;
  /**
   * Upsert. A plugin row is a pure projection of the repository — nothing on
   * it is operator-authored — so unlike every other registry write there is no
   * edit to protect and no create/update distinction worth failing over.
   */
  put(plugin: Plugin): Promise<void>;
  delete(name: string): Promise<void>;
}
