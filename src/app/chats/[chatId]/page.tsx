import { ChatThread } from "../_components/ChatThread";
import { WorkspacePanel } from "@/app/workspaces/_components/WorkspacePanel";
import { getSessionUser } from "@/lib/session";
import { workspaceUseCases } from "@/lib/container";

export default async function ChatPage({ params }: { params: Promise<{ chatId: string }> }) {
  const { chatId } = await params;
  const user = await getSessionUser();
  const workspaceId = user ? await workspaceUseCases.forChat(chatId, user.email).catch(() => null) : null;
  if (workspaceId) return <WorkspacePanel key={workspaceId} id={workspaceId} />;
  // Keyed by the chat, so moving between two of them is a fresh view rather
  // than the same one carrying the last chat's state.
  //
  // Every piece of that state is per-chat and none of it was being reset:
  // `sessionImagesBySeq` is keyed by `message.seq`, which restarts at 0 for
  // each chat, so this session's picture from chat A was substituted onto
  // whatever sat at that sequence in chat B — replacing that message's own
  // images, or giving a plain text turn a picture from another conversation.
  // `landed` stayed true, so B opened at A's scroll offset instead of at its
  // newest turn; `status` and `messages` stayed, so B's URL drew A's
  // transcript until the fetch returned. A remount answers all of them at
  // once, and cannot go stale the way a list of things to clear does.
  return <ChatThread key={chatId} chatId={chatId} />;
}
