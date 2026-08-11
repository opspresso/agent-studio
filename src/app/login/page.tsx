import { redirect } from "next/navigation";
import { Alert, Card, Center, Stack, Text, Title } from "@mantine/core";
import { SignInButton } from "@/components/SignInButton";
import { getSessionUser } from "@/lib/session";
import { safeNextPath } from "@/shared/safeNextPath";
import { signInErrorMessage } from "@/shared/signInError";

export const metadata = { title: "Sign in · Agent Studio" };

/**
 * Where `proxy.ts` sends a signed-out visitor.
 *
 * A server component so the already-signed-in case is settled before anything
 * renders: arriving here with a session — a stale bookmark, a second tab that
 * signed in meanwhile — bounces straight on rather than showing a sign-in
 * button that does nothing.
 *
 * Also where a *refused* sign-in lands (`onAPIError.errorURL` in `lib/auth.ts`),
 * because the thing someone turned away needs most is the button to try again
 * with a different account.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next = safeNextPath(params.next);

  if (await getSessionUser()) {
    redirect(next);
  }

  const error = signInErrorMessage(params.error);

  return (
    <Center mih="60vh">
      <Card maw={420} w="100%" padding="xl">
        <Stack gap="md" align="center" ta="center">
          {error ? (
            <Alert color="red" variant="light" w="100%" ta="left">
              {error}
            </Alert>
          ) : null}
          <Title order={1} fz="h3">
            Sign in to continue
          </Title>
          <Text fz="sm" c="dimmed" lh={1.6}>
            Sign in with your Google account on one of this deployment&rsquo;s allowed domains.
          </Text>
          <SignInButton callbackURL={next} />
        </Stack>
      </Card>
    </Center>
  );
}
