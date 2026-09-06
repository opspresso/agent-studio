import { Box, Flex } from "@mantine/core";
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
      <Box component="section" style={{ flex: 1, minWidth: 0, minHeight: 0, border: "1px solid var(--studio-border)", borderRadius: "var(--mantine-radius-lg)", background: "var(--studio-surface)", padding: "var(--mantine-spacing-sm)" }}>
        {children}
      </Box>
    </Flex>
  );
}
