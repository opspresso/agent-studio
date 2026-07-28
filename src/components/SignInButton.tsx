"use client";

import { useState } from "react";
import { Button } from "@mantine/core";
import { signIn } from "@/lib/auth-client";

export function SignInButton({
  label = "Sign in with Google",
  compact = false,
  callbackURL = "/",
}: {
  label?: string;
  compact?: boolean;
  /**
   * Where Google returns the user. `/login` passes the page they were turned
   * away from, so the round trip ends where it started; it has already been
   * through `safeNextPath`, and Better Auth only accepts same-origin values.
   */
  callbackURL?: string;
}) {
  const [pending, setPending] = useState(false);

  async function handleSignIn() {
    setPending(true);
    try {
      await signIn.social({ provider: "google", callbackURL });
    } catch {
      setPending(false);
    }
  }

  return (
    <Button
      onClick={() => void handleSignIn()}
      loading={pending}
      size={compact ? "xs" : "md"}
    >
      {label}
    </Button>
  );
}
