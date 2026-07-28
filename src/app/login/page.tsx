import { redirect } from "next/navigation";
import { Card, Center, Stack, Text, Title } from "@mantine/core";
import { SignInButton } from "@/components/SignInButton";
import { getSessionUser } from "@/lib/session";
import { safeNextPath } from "@/shared/safeNextPath";

export const metadata = { title: "Sign in · Agent Studio" };

/**
 * Where `middleware.ts` sends a signed-out visitor.
 *
 * A server component so the already-signed-in case is settled before anything
 * renders: arriving here with a session — a stale bookmark, a second tab that
 * signed in meanwhile — bounces straight on rather than showing a sign-in
 * button that does nothing.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNextPath((await searchParams).next);

  if (await getSessionUser()) {
    redirect(next);
  }

  return (
    <Center mih="60vh">
      <Card maw={420} w="100%" padding="xl">
        <Stack gap="md" align="center" ta="center">
          <Title order={1} fz="h3">
            Sign in to continue
          </Title>
          <Text fz="sm" c="dimmed" lh={1.6}>
            This page is part of the Agent Studio workspace. Sign in with your work Google account
            to open it.
          </Text>
          <SignInButton callbackURL={next} />
        </Stack>
      </Card>
    </Center>
  );
}
