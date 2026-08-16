import { redirect } from "next/navigation";
import { tierAtLeast } from "@/domain/member/tiers";
import { getSessionUser } from "@/lib/session";

/**
 * Turn a tier below `member` away from the pages that list the capability
 * registries, before either renders — the page half of what `withMemberAuth`
 * does for the routes behind them.
 *
 * Hiding the sidebar group is not enough on its own — the four pages are
 * reachable by typing the address, and the layout that draws the nav already
 * says why a collapsed link is still a leak. This is the server half of the
 * same rule, called from each section's `layout.tsx`, which is the only server
 * component on those routes: the pages themselves are `"use client"`.
 *
 * A signed-out visitor is not this function's business. `src/proxy.ts` has
 * already sent them to `/login`, and it is the single owner of that decision.
 */
export async function assertIntelligenceVisible(): Promise<void> {
  const user = await getSessionUser();
  if (user && !tierAtLeast(user.tier, "member")) {
    redirect("/");
  }
}
