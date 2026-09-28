import type { SkillRepository } from "@/domain/skill/repository";

/**
 * A consistent skill fixture: `describe` follows the current `repo.get`, including
 * replacements made after construction. Tests needing independent projected
 * reads stub the two methods separately; SQL projection is an integration check.
 */
export function fakeSkillRepository(
  get: SkillRepository["get"] = async () => {
    throw new Error("skills.get is not used in this test");
  },
): SkillRepository {
  const unused = () => Promise.reject(new Error("not used in this test"));
  const repo: SkillRepository = {
    get,
    async describe(names) {
      // Through `repo.get`, not the captured argument: a test that reassigns
      // `deps.skills.get` has to change what `describe` sees too.
      const found = await Promise.all(names.map((name) => repo.get(name)));
      // Keyed by the requested name, like the real one — an item whose stored
      // `name` has drifted from its key is still the skill that was asked for.
      return names.flatMap((name, index) => {
        const skill = found[index];
        return skill ? [{ name, description: skill.description, ...(skill.source ? { source: skill.source } : {}) }] : [];
      });
    },
    list: unused,
    create: unused,
    update: unused,
    put: unused,
    delete: unused,
  };
  return repo;
}
