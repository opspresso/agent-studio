"use client";

import { useState } from "react";
import { Button, Group, Text } from "@mantine/core";
import { signOut } from "@/lib/auth-client";
import { SignInButton } from "./SignInButton";

/**
 * `email` comes from the root layout's server-resolved viewer, not from
 * `useSession()`. The hook has no cookie during SSR, so this rendered a
 * loading skeleton on the client over a server-rendered sign-out button —
 * a hydration mismatch on every page. See `src/app/layout.tsx`.
 */
export function UserMenu({ email }: { email: string | null }) {
  const [signingOut, setSigningOut] = useState(false);

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
    return <SignInButton compact />;
  }

  return (
    <Group gap="xs" wrap="nowrap">
      <Text fz="sm" c="dimmed" truncate maw={210} visibleFrom="lg">
        {email}
      </Text>
      <Button
        variant="default"
        size="xs"
        onClick={() => void handleSignOut()}
        loading={signingOut}
      >
        Sign out
      </Button>
    </Group>
  );
}
