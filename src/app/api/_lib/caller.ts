import type { RunCaller } from "@/domain/execution/actor";
import { callerFrom } from "@/domain/execution/actor";
import type { SessionUser } from "@/lib/session";

/**
 * Build the signed-in caller through callerFrom, which sanitizes prompt fields.
 * Sessions carry no timezone; Slack builds its caller from the profile instead.
 */
export function sessionCaller(user: SessionUser): RunCaller | null {
  return callerFrom({
    displayName: user.name,
    ...(user.image ? { avatarUrl: user.image } : {}),
  });
}
