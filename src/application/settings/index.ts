import { settingsRepository } from "@/infrastructure/db/repositories/settingsRepository";
import { secretCipher } from "@/infrastructure/crypto/secretCipher";
import { createSettingsUseCases } from "./settingsUseCases";

export * from "./settingsUseCases";

/**
 * Composition point for the settings slice: wires the DynamoDB repository to
 * the use cases. Route handlers import this instance so they never touch
 * infrastructure directly.
 */
export const settingsUseCases = createSettingsUseCases(settingsRepository, secretCipher);
