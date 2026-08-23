import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export const { signIn, signOut, useSession } = authClient;

/**
 * Start a sign-in with the OIDC provider `lib/auth.ts` registers under its
 * `providerId`. The generic OAuth plugin's endpoint, called directly: the
 * server answers with the authorization URL, and the browser goes there.
 */
export async function signInWithOidc(providerId: string, callbackURL: string): Promise<void> {
  const { data, error } = await authClient.$fetch<{ url: string; redirect: boolean }>(
    "/sign-in/oauth2",
    { method: "POST", body: { providerId, callbackURL } },
  );
  if (error || !data?.url) {
    throw new Error(error?.message ?? "sign-in did not start");
  }
  window.location.assign(data.url);
}
