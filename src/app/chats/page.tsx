import { NewChatEntry } from "./_components/NewChatEntry";
import { getWorkspaceConfig } from "@/lib/runtime-settings";
import { getSessionUser } from "@/lib/session";
import { tierAtLeast } from "@/domain/member/tiers";

export default async function NewChatPage() {
  const enabled = !!getWorkspaceConfig();
  const user = enabled ? await getSessionUser() : null;
  return <NewChatEntry workspacesEnabled={enabled && !!user && tierAtLeast(user.tier, "member")} />;
}
