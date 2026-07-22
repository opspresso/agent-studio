"use client";

import { signIn } from "@/lib/auth-client";

export function SignInButton({ label = "Sign in with Google" }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => signIn.social({ provider: "google", callbackURL: "/" })}
      className="rounded-md bg-brand px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      {label}
    </button>
  );
}
