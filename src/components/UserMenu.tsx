"use client";

import { useState } from "react";
import Link from "next/link";
import { ActionIcon, Avatar, Menu, Text } from "@mantine/core";
import { IconLogout, IconUser } from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";
import { reportError } from "@/app/_lib/reportError";
import { signOut } from "@/lib/auth-client";
import { SignInButton, type SignInProviders } from "./SignInButton";

/**
 * Header account menu with email, Profile and sign-out controls at every width.
 * The root layout supplies the resolved email so SSR and hydration agree.
 */
export function UserMenu({
  email,
  image,
  signInProviders,
}: {
  email: string | null;
  /**
   * The identity provider's picture, when it gave one. Mantine falls back to
   * the initial below whenever the URL is absent *or* fails to load, which is
   * what an install with no route to the provider's CDN gets: a letter, not a
   * broken image.
   */
  image: string | null;
  signInProviders: SignInProviders;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const t = useT();

  async function handleSignOut() {
    setSigningOut(true);
    try {
      const { data, error } = await signOut();
      if (error || data?.success !== true) {
        throw new Error(error?.message ?? t("auth.signOutFailed"));
      }
      window.location.assign("/");
    } catch (error) {
      reportError(error, t("auth.signOutFailed"));
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
        <ActionIcon
          variant="default"
          size="lg"
          radius="xl"
          aria-label={t("auth.account")}
          title={email}
        >
          {/* Filling the round button, so a photo reads as the account rather
              than as a picture someone put in a box. */}
          <Avatar src={image} size={26} radius="xl" color="brand" variant="light">
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
