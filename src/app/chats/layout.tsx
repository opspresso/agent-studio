import { Flex, Paper } from "@mantine/core";
import { ChatSidebar } from "./_components/ChatSidebar";

export const metadata = { title: "Chats" };

export default function ChatsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Flex
      direction={{ base: "column", md: "row" }}
      gap="md"
      h={{ base: "calc(100dvh - 10rem)", md: "calc(100dvh - 8rem)" }}
    >
      <ChatSidebar />
      <Paper component="section" withBorder p="sm" style={{ flex: 1, minWidth: 0, minHeight: 0, background: "var(--studio-surface)" }}>
        {children}
      </Paper>
    </Flex>
  );
}
