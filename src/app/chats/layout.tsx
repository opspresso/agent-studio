import { ChatSidebar } from "./_components/ChatSidebar";

export default function ChatsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4">
      <ChatSidebar />
      <section className="min-w-0 flex-1">{children}</section>
    </div>
  );
}
