"use client";

import { useState } from "react";
import Link from "next/link";
import { ActionIcon, Avatar, Menu, Text } from "@mantine/core";
import { IconLogout, IconUser } from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";
import { signOut } from "@/lib/auth-client";
import { SignInButton, type SignInProviders } from "./SignInButton";

/**
 * The account control, third in the header beside language and colour scheme.
 *
 * It is a menu for the same reason those two are: the header holds one control
 * per kind of choice, and the account's choices are "who am I signed in as",
 * "my page", and "leave". As a bare pair — an email link and a sign-out button
 * — the most destructive of the three was the most prominent thing in the
 * chrome, and the email was `visibleFrom="lg"`, so on a laptop nothing said
 * which account the workspace belonged to. The address now lives inside the
 * dropdown, where it is legible at every width and does not have to be
 * truncated.
 *
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
    <Menu position="bottom-end" width={240} withinPortal>
      <Menu.Target>
        <ActionIcon variant="default" size="lg" aria-label={t("auth.account")} title={email}>
          {/* The initial, not a photo: no identity provider here supplies one. */}
          <Avatar size={22} radius="xl" color="brand" variant="light">
            {email.slice(0, 1).toUpperCase()}
          </Avatar>
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>
          <Text fz="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
            {email}
          </Text>
        </Menu.Label>
        <Menu.Item component={Link} href="/profile" leftSection={<IconUser size={16} stroke={1.8} />}>
          {t("nav.profile")}
        </Menu.Item>
        <Menu.Divider />
        <Menu.Item
          color="red"
          disabled={signingOut}
          leftSection={<IconLogout size={16} stroke={1.8} />}
          onClick={() => void handleSignOut()}
        >
          {t("auth.signOut")}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
