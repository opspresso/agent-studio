"use client";

import { useState } from "react";
import { Button } from "@mantine/core";
import { signIn } from "@/lib/auth-client";

export function SignInButton({
  label = "Sign in with Google",
  compact = false,
}: {
  label?: string;
  compact?: boolean;
}) {
  const [pending, setPending] = useState(false);

  async function handleSignIn() {
    setPending(true);
    try {
      await signIn.social({ provider: "google", callbackURL: "/" });
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
