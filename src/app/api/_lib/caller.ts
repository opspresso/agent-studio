import type { RunCaller } from "@/domain/execution/actor";
import { callerFrom } from "@/domain/execution/actor";
import type { SessionUser } from "@/lib/session";

/**
 * The signed-in user as a run caller, for the surfaces that have one.
 *
 * One helper rather than a `callerFrom` call in each route, for the reason the
 * feature needed fixing at all: it reached exactly one surface. Slack resolved a
 * caller and nothing else did, so a version that opted into `callerContext`
 * behaved differently depending on where it was run — and the Playground, the
 * one place an author checks their prompt, was among the surfaces that showed
 * nothing.
 *
 * No timezone: a session says who is asking, not where they are. Slack's profile
 * does carry one, which is why that surface builds its caller from the profile
 * rather than from this.
 *
 * `callerFrom` stays the owner of what is safe to put in a prompt — a display
 * name is attacker-controlled on any surface that lets someone set it.
 */
export function sessionCaller(user: SessionUser): RunCaller | null {
  return callerFrom({
    displayName: user.name,
    ...(user.image ? { avatarUrl: user.image } : {}),
  });
}
