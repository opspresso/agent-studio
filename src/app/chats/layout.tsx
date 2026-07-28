import { Box, Flex } from "@mantine/core";
import { ChatSidebar } from "./_components/ChatSidebar";

export default function ChatsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Flex
      direction={{ base: "column", md: "row" }}
      gap="md"
      h={{ base: "calc(100dvh - 10rem)", md: "calc(100dvh - 8rem)" }}
    >
      <ChatSidebar />
      <Box component="section" style={{ flex: 1, minWidth: 0 }}>
        {children}
      </Box>
    </Flex>
  );
}
