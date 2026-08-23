"use client";

import { useState } from "react";
import Link from "next/link";
import { Anchor, Button, Group } from "@mantine/core";
import { useT } from "@/app/_i18n/provider";
import { signOut } from "@/lib/auth-client";
import { SignInButton, type SignInProviders } from "./SignInButton";

/**
 * `email` comes from the root layout's server-resolved viewer, not from
 * `useSession()`. The hook has no cookie during SSR, so this rendered a
 * loading skeleton on the client over a server-rendered sign-out button —
 * a hydration mismatch on every page. See `src/app/layout.tsx`.
 */
export function UserMenu({
  email,
  signInProviders,
}: {
  email: string | null;
  signInProviders: SignInProviders;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const t = useT();

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
      window.location.assign("/");
    } catch {
      setSigningOut(false);
    }
  }

  if (email === null) {
    // The header offers the providers only; the password form is the login
    // page's, where there is room for it.
    return <SignInButton compact providers={{ ...signInProviders, password: false }} />;
  }

  return (
    <Group gap="xs" wrap="nowrap">
      <Anchor
        component={Link}
        href="/profile"
        underline="hover"
        fz="sm"
        c="dimmed"
        truncate
        maw={210}
        visibleFrom="lg"
      >
        {email}
      </Anchor>
      <Button
        variant="default"
        size="xs"
        onClick={() => void handleSignOut()}
        loading={signingOut}
      >
        {t("auth.signOut")}
      </Button>
    </Group>
  );
}
