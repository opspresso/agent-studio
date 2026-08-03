import type { AppSettings } from "./types";

export interface SettingsRepository {
  get(): Promise<AppSettings | null>;
  put(settings: AppSettings): Promise<void>;
  /**
   * One workspace's overrides, or null. A separate pair rather than a tenant
   * argument on the app row's reader: the two answer different questions —
   * "what did this deployment configure" and "what did this workspace decide
   * differently" — and the resolution needs both at once.
   */
  getTenant(tenant: string): Promise<AppSettings | null>;
  putTenant(tenant: string, settings: AppSettings): Promise<void>;
}
