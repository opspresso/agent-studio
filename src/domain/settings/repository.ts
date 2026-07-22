import type { AppSettings } from "./types";

export interface SettingsRepository {
  get(): Promise<AppSettings | null>;
  put(settings: AppSettings): Promise<void>;
}
