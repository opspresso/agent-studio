import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export const { signIn, signOut, useSession } = authClient;

/**
 * Start a sign-in with the OIDC provider `lib/auth.ts` registers under its
 * `providerId`. Generic OAuth providers use the standard social endpoint;
 * Better Auth redirects the browser to the returned authorization URL.
 */
export async function signInWithOidc(providerId: string, callbackURL: string): Promise<void> {
  const { data, error } = await signIn.social({ provider: providerId, callbackURL });
  if (error || !data?.url) {
    throw new Error(error?.message ?? "sign-in did not start");
  }
}
