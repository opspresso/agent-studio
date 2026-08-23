"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Divider, PasswordInput, Stack, TextInput } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { authClient, signIn, signInWithOidc } from "@/lib/auth-client";

/** Which ways in this deployment offers; `config.authProviders` decides. */
export interface SignInProviders {
  google: boolean;
  oidc: { displayName: string } | undefined;
  password: boolean;
}

/**
 * The sign-in controls, one per configured provider.
 *
 * `callbackURL` is where a provider returns the user. `/login` passes the
 * page they were turned away from, so the round trip ends where it started;
 * it has already been through `safeNextPath`, and Better Auth only accepts
 * same-origin values.
 */
export function SignInButton({
  providers,
  label,
  compact = false,
  callbackURL = "/",
}: {
  providers: SignInProviders;
  /** Overrides the default wording of the provider buttons. */
  label?: string;
  compact?: boolean;
  callbackURL?: string;
}) {
  const [pending, setPending] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const t = useT();
  const size = compact ? "xs" : "md";

  async function withPending(action: () => Promise<unknown>) {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch {
      setPending(false);
    }
  }

  const oidc = providers.oidc;
  const buttons = [
    ...(oidc
      ? [
          <Button
            key="oidc"
            size={size}
            loading={pending}
            onClick={() => void withPending(() => signInWithOidc("oidc", callbackURL))}
          >
            {label ?? t("auth.signInWith", { provider: oidc.displayName })}
          </Button>,
        ]
      : []),
    ...(providers.google
      ? [
          <Button
            key="google"
            size={size}
            variant={oidc ? "default" : "filled"}
            loading={pending}
            onClick={() => void withPending(() => signIn.social({ provider: "google", callbackURL }))}
          >
            {label ?? t("auth.signInWith", { provider: "Google" })}
          </Button>,
        ]
      : []),
  ];

  if (!providers.password) {
    if (buttons.length === 0) {
      // Nothing to offer here — a password-only deployment seen from the
      // header, or one with no provider at all. The login page has the form,
      // or the explanation.
      return (
        <Button component={Link} href={`/login?next=${encodeURIComponent(callbackURL)}`} size={size}>
          {label ?? t("auth.signIn")}
        </Button>
      );
    }
    return buttons.length === 1 ? buttons[0] : <Stack gap="xs">{buttons}</Stack>;
  }

  // Password sign-in is the last resort, shown under the providers: it is for
  // the first administrator and for the day the identity provider is down.
  return (
    <Stack gap="sm" w="100%">
      {buttons}
      {buttons.length > 0 ? <Divider label={t("auth.or")} labelPosition="center" /> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void withPending(async () => {
            const result = await authClient.signIn.email({ email, password, callbackURL });
            if (result.error) {
              setError(result.error.message ?? t("auth.passwordFailed"));
              setPending(false);
            }
          });
        }}
      >
        <Stack gap="xs">
          <TextInput
            type="email"
            size={size}
            label={t("auth.email")}
            value={email}
            onChange={(event) => setEmail(event.currentTarget.value)}
            autoComplete="username"
            required
          />
          <PasswordInput
            size={size}
            label={t("auth.password")}
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            autoComplete="current-password"
            error={error}
            required
          />
          <Button type="submit" size={size} variant="default" loading={pending}>
            {t("auth.signInWithPassword")}
          </Button>
        </Stack>
      </form>
    </Stack>
  );
}
