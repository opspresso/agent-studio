import type { SkillRepository } from "@/domain/skill/repository";

/**
 * A skill repository whose `describe` answers from its own `get`.
 *
 * A run reads a skill's description and its body through different methods now —
 * the prompt's table takes descriptions, the `Skill` tool takes the body — and a
 * fixture that stubbed one of them would let a test pass against a registry no
 * run could have seen. Tests set `get` (before or after construction, as several
 * do) and `describe` follows it.
 *
 * What that buys is a *self-consistent* fake, not a faithful one: the real
 * `describe` issues its own projected read and cannot be checked here for
 * agreeing with `get`. That is the integration check's job — it exercises both
 * against a real table — and it is why a test that cares which read a run made
 * (`runProject.test.ts`, "describes without reading a body") stubs the two
 * separately instead of using this.
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
        return skill ? [{ name, description: skill.description }] : [];
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
