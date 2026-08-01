/**
 * The name every registry entry, project and skill is addressed by.
 *
 * One owner, because it was written out ten times — three API schemas, the
 * route-param check, both repo sync clients, and prose in this file's own
 * comment — while the door they all go through (`createRegistryUseCases.create`)
 * checked nothing at all. Nothing was wrong, but nothing made it right either:
 * a name that slipped past one copy would be stored and then be unreadable,
 * because `parseName` refuses it on the way back out.
 */
const SLUG = /^[a-z0-9-]+$/;

/** True when `value` may be used as a name. */
export function isSlug(value: string): boolean {
  return SLUG.test(value);
}

/** What a name that is not a slug should say, wherever it is refused. */
export const SLUG_RULE = "must be a slug (lowercase letters, digits, hyphens)";

/**
 * The managed-workload name rule: a slug that is also a valid DNS label —
 * starts alphanumeric, 63 characters at most — because the name is reused as
 * the Docker container's name and inside an SSM parameter path. Four call
 * sites (the create route, both provisioners, the console form) each spelled
 * it out before it had an owner.
 */
export const MANAGED_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Normalizes user input to the slug format {@link isSlug} accepts.
export function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
