"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Stack, Tabs, Text } from "@mantine/core";
import { useViewer } from "@/app/_lib/useViewer";

/**
 * Sub-navigation for the four administrative surfaces.
 *
 * They live under one nav entry rather than four because they answer one
 * question — how is this installation configured — and because three of them
 * are admin-only: a top-level link most users can only be refused is worse
 * than one they never see. Same Tabs shape as the project detail layout, and
 * the same reason for deriving `value` from the pathname: navigation is what
 * changes the tab, so a direct load and the back button stay correct.
 *
 * Which tabs appear is a *display* decision. Every page behind them asks the
 * server again, and the server is where the answer counts — hiding a tab has
 * never been the gate.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const viewer = useViewer();

  /*
   * `role` is present exactly when the caller is in a named workspace — that is
   * the `/api/me` contract, and using it keeps the default tenant's name from
   * being written out a second time on the client, where the module that owns
   * it cannot be imported (it holds an `AsyncLocalStorage`).
   */
  const inWorkspace = viewer?.role !== undefined;

  const tabs = [
    { href: "/settings", label: "App", show: viewer?.isDeploymentAdmin === true },
    // The default workspace *is* the deployment: it has no second settings row
    // to edit, so the page there would only ever refuse.
    {
      href: "/settings/workspace",
      label: "Workspace",
      show: viewer !== null && inWorkspace && viewer.isAdmin,
    },
    {
      href: "/settings/members",
      label: "Members",
      // Inside a workspace this manages its members; outside one it is where a
      // deployment's workspaces are created, which is not a workspace's to do.
      show: viewer !== null && (inWorkspace ? viewer.isAdmin : viewer.isDeploymentAdmin),
    },
    // `isConfiguredAdmin`, not `isAdmin`: the trail is read behind the gate
    // with no empty-list fail-open, so `isAdmin` would offer the tab to
    // everyone on a deployment that never named an operator and then 403.
    { href: "/settings/audit", label: "Audit", show: viewer?.isConfiguredAdmin === true },
  ].filter((tab) => tab.show);

  return (
    <Stack gap="lg">
      {tabs.length > 0 && (
        <Tabs value={pathname} variant="default">
          <Tabs.List style={{ flexWrap: "nowrap", overflowX: "auto" }}>
            {tabs.map((tab) => (
              <Tabs.Tab
                key={tab.href}
                value={tab.href}
                renderRoot={(props) => <Link href={tab.href} {...props} />}
              >
                {tab.label}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs>
      )}
      {viewer !== null && tabs.length === 0 && (
        <Text fz="sm" c="dimmed">
          Settings are administered by your workspace admin.
        </Text>
      )}
      {children}
    </Stack>
  );
}
