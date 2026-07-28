"use client";

import { useState } from "react";
import { Button, Group, Skeleton, Text } from "@mantine/core";
import { signOut, useSession } from "@/lib/auth-client";
import { SignInButton } from "./SignInButton";

export function UserMenu() {
  const { data: session, isPending } = useSession();
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

  if (isPending) {
    return <Skeleton height={32} circle />;
  }

  if (!session) {
    return <SignInButton compact />;
  }

  return (
    <Group gap="xs" wrap="nowrap">
      <Text fz="sm" c="dimmed" truncate maw={210} visibleFrom="lg">
        {session.user.email}
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
