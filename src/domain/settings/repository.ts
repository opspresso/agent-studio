import type { AppSettings } from "./types";

export interface SettingsUpdateResult {
  before: AppSettings | null;
  after: AppSettings;
}

export interface SettingsRepository {
  get(): Promise<AppSettings | null>;
  /** Apply a synchronous mutation to the latest row under one storage lock. */
  update(mutate: (settings: AppSettings | null) => AppSettings): Promise<SettingsUpdateResult>;
}
