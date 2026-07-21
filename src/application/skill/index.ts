import { skillRepository } from "@/infrastructure/db/repositories/skillRepository";
import { createSkillUseCases } from "./skillUseCases";

export * from "./skillUseCases";
export { skillRepository };

/**
 * Composition point for the skill slice: wires the DynamoDB repository to the
 * use cases. Route handlers import this instance so they never touch
 * infrastructure directly.
 */
export const skillUseCases = createSkillUseCases(skillRepository);
