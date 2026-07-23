import { ChatSidebar } from "./_components/ChatSidebar";

export default function ChatsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[calc(100dvh-10rem)] flex-col gap-4 md:h-[calc(100dvh-8rem)] md:flex-row">
      <ChatSidebar />
      <section className="min-w-0 flex-1">{children}</section>
    </div>
  );
}
