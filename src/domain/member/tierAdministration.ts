import type { MemberRepository } from "./repository";
import type { SettingsRepository } from "../settings/repository";

/** Serialize tier assignment with catalog deletion across every app instance. */
export interface MemberTierAdministration {
  withLock<T>(work: (repositories: { members: MemberRepository; settings: SettingsRepository }) => Promise<T>): Promise<T>;
}
