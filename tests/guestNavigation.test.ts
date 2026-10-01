import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it, vi } from "vitest";
import { AppLayout } from "@/components/AppLayout";
import { I18nProvider } from "@/app/_i18n/provider";
import { canEditAgent } from "@/app/_lib/useViewer";
import { resolveBranding } from "@/shared/branding";
import type { Viewer } from "@/lib/viewer";

vi.mock("next/navigation", () => ({ usePathname: () => "/skills", useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/UserMenu", () => ({ UserMenu: () => null }));

const viewer = (tier: Viewer["tier"]): Viewer => ({ email: "user@example.test", tier, isAdmin: tier === "admin", isConfiguredAdmin: tier === "admin" });
function navigation(tier: Viewer["tier"]) {
  const html = renderToStaticMarkup(createElement(MantineProvider, {
    children: createElement(I18nProvider, { locale: "en", children: createElement(AppLayout, {
      branding: resolveBranding(), version: "test", viewer: viewer(tier), userImage: null,
      signInProviders: { google: false, password: false, keycloak: false, oidc: undefined }, children: "content",
    }) }),
  }));
  return [...html.matchAll(/href="([^"]+)"/g)].map(match => match[1]);
}

describe("guest navigation and editing", () => {
  it("renders the same navigation for guest and member, including every catalog", () => {
    const guest = navigation("guest");
    expect(guest).toEqual(navigation("member"));
    expect(guest).toEqual(expect.arrayContaining(["/agents", "/chats", "/artifacts", "/plugins", "/skills", "/tools", "/models", "/profile", "/guide"]));
    expect(guest).not.toContain("/settings");
    expect(navigation("admin")).toEqual(expect.arrayContaining(["/settings", "/members", "/audit"]));
  });
  it("keeps a downgraded owner read-only without changing member ownership or admin access", () => {
    expect(canEditAgent(viewer("guest"), "user@example.test")).toBe(false);
    expect(canEditAgent(viewer("member"), "user@example.test")).toBe(true);
    expect(canEditAgent(viewer("member"), "other@example.test")).toBe(false);
    expect(canEditAgent(viewer("admin"), "other@example.test")).toBe(true);
  });
});
