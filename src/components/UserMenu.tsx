"use client";

import { useState } from "react";
import Link from "next/link";
import { ActionIcon, Avatar, Badge, Group, Menu, Stack, Text } from "@mantine/core";
import { IconLogout, IconUser } from "@tabler/icons-react";
import { useT } from "@/app/_i18n/provider";
import { reportError } from "@/app/_lib/reportError";
import { memberTierColor } from "@/app/_components/badgeColors";
import type { MemberTier } from "@/domain/member/tiers";
import { signOut } from "@/lib/auth-client";
import { SignInButton, type SignInProviders } from "./SignInButton";

/**
 * Header account identity, Profile and sign-out controls at every width.
 * The root layout supplies the identity so SSR and hydration agree.
 */
export function UserMenu({
  email,
  name,
  tier,
  image,
  signInProviders,
}: {
  email: string | null;
  name: string | null;
  tier: MemberTier | null;
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
  const displayName = name?.trim() || email;

  return (
    <Menu position="bottom-end" width={300} withinPortal>
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
          <Group gap="sm" wrap="nowrap" align="flex-start">
            <Avatar src={image} size={40} radius="xl" color="brand" variant="light">
              {displayName.slice(0, 1).toUpperCase()}
            </Avatar>
            <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
              <Group gap={6}>
                <Text fz="sm" fw={600} c="var(--mantine-color-text)" style={{ overflowWrap: "anywhere" }}>
                  {displayName}
                </Text>
                {tier !== null && <Badge size="sm" variant="light" color={memberTierColor(tier)}
                  aria-label={`${t("members.tier")}: ${tier}`}
                  styles={{ root: { maxWidth: "100%", height: "auto", minHeight: 18 },
                    label: { whiteSpace: "normal", overflowWrap: "anywhere" } }}>
                  {tier}
                </Badge>}
              </Group>
              <Text fz="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
                {email}
              </Text>
            </Stack>
          </Group>
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
