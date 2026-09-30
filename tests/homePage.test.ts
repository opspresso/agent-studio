import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Home from "@/app/page";
import { I18nProvider } from "@/app/_i18n/provider";
import { Overview } from "@/app/_components/Overview";
import { theme } from "@/app/theme";
import { getServiceBranding } from "@/lib/runtime-settings";
import { getSessionUser } from "@/lib/session";
import { resolveBranding } from "@/shared/branding";

vi.mock("@/lib/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/runtime-settings", () => ({ getServiceBranding: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/_components/Overview", () => ({ Overview: () => null }));

beforeEach(() => { vi.clearAllMocks(); });

describe("public home branding", () => {
  it.each([
    ["AXLEON AgentOps", "agentops"],
    ["Research Studio", "agent-studio"],
  ])("uses the selected name and original assets for %s", async (name, logo) => {
    const branding = resolveBranding(name, logo);
    vi.mocked(getSessionUser).mockResolvedValue(null);
    vi.mocked(getServiceBranding).mockResolvedValue(branding);
    const html = renderToStaticMarkup(createElement(MantineProvider, {
      theme,
      children: createElement(I18nProvider, { locale: "en", children: await Home() }),
    }));
    const images = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map(match => {
      const src = new URL(match[1]!.replaceAll("&amp;", "&"), "http://localhost");
      return src.searchParams.get("url") ?? src.pathname;
    });
    expect(images.length).toBeGreaterThanOrEqual(4);
    expect(images.every(src => src === branding.logoUrl)).toBe(true);
    expect(html).toContain(`aria-label="${name}"`);
    expect(html).toContain(`>${name}</`);
  });

  it("keeps signed-in users on their overview", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ id: "member-1", email: "member@example.com", name: "Member", image: null, tier: "member" });
    const page = await Home();
    expect(page.type).toBe(Overview);
    expect(page.props).toMatchObject({ userEmail: "member@example.com", tier: "member" });
    expect(getServiceBranding).not.toHaveBeenCalled();
  });
});
