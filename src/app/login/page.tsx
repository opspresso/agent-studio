import { redirect } from "next/navigation";
import { Alert, Anchor, Card, Center, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { IconRobot } from "@tabler/icons-react";
import { SignInButton } from "@/components/SignInButton";
import { config } from "@/lib/config";
import { getSessionUser } from "@/lib/session";
import { safeNextPath } from "@/shared/safeNextPath";
import { signInErrorMessage } from "@/shared/signInError";
import { getT } from "../_i18n/server";

export const metadata = { title: "Sign in" };

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

  // The refusal itself stays in English: it is an `AppError`-shaped string from
  // `shared/signInError.ts`, which the console does not translate.
  const error = signInErrorMessage(params.error);
  const t = await getT();

  return (
    <Center mih="60vh">
      <Card maw={460} w="100%" padding="xl">
        <Stack gap="lg" align="center" ta="center">
          <ThemeIcon size={52} variant="light" color="brand" radius="lg">
            <IconRobot size={28} stroke={1.6} />
          </ThemeIcon>
          {error ? (
            <Alert color="red" variant="light" w="100%" ta="left">
              {error}
            </Alert>
          ) : null}
          <Title order={1} fz="h2">
            {t("login.title")}
          </Title>
          <Text fz="sm" lh={1.6}>
            {t("login.product")}
          </Text>
          <Text fz="sm" c="dimmed" lh={1.6}>
            {t("login.domains")}
          </Text>
          <SignInButton providers={config.authProviders} callbackURL={next} />
          <Anchor href="/guide" fz="sm">{t("nav.guide")}</Anchor>
        </Stack>
      </Card>
    </Center>
  );
}
