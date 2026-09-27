import { ChatThread } from "../_components/ChatThread";
import { WorkspacePanel } from "@/app/workspaces/_components/WorkspacePanel";
import { getSessionUser } from "@/lib/session";
import { workspaceUseCases } from "@/lib/container";
import { NotFoundError } from "@/application/errors";

export default async function ChatPage({ params }: { params: Promise<{ chatId: string }> }) {
  const { chatId } = await params;
  const user = await getSessionUser();
  // Let the thread draw its own not-found state; other lookup failures are page errors.
  const workspaceId = user ? await workspaceUseCases.forChat(chatId, user.email).catch((error) => {
    if (error instanceof NotFoundError) return null;
    throw error;
  }) : null;
  if (workspaceId) return <WorkspacePanel key={workspaceId} id={workspaceId} />;
  // Remount per Chat so sequence-scoped image pins, scroll state and pending
  // responses cannot enter another conversation.
  return <ChatThread key={chatId} chatId={chatId} />;
}
