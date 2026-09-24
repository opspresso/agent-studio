import { describe, expect, it, vi } from "vitest";
import { openMcpAuthorizationPopup } from "@/app/agents/[name]/_components/McpConnectionCard";

describe("MCP authorization popup", () => {
  it("opens during the click before waiting for the authorization URL", async () => {
    const order: string[] = [];
    let finishUrl!: (url: string) => void;
    const url = new Promise<string>((resolve) => { finishUrl = resolve; });
    const popup = { closed: false, location: { href: "about:blank" }, close: vi.fn() };

    const started = openMcpAuthorizationPopup(
      () => { order.push("authorize"); return url; },
      () => { order.push("open"); return popup; },
    );

    expect(order).toEqual(["open", "authorize"]);
    finishUrl("https://issuer.example.com/authorize");
    await started;
    expect(popup.location.href).toBe("https://issuer.example.com/authorize");
  });

  it("does not begin authorization when the browser blocks the popup", async () => {
    const authorize = vi.fn(async () => "https://issuer.example.com/authorize");
    await expect(openMcpAuthorizationPopup(authorize, () => null))
      .rejects.toThrow("Browser blocked the authorization popup");
    expect(authorize).not.toHaveBeenCalled();
  });

  it("closes the placeholder when authorization cannot begin", async () => {
    const popup = { closed: false, location: { href: "about:blank" }, close: vi.fn() };
    await expect(openMcpAuthorizationPopup(
      async () => { throw new Error("Authorization unavailable"); },
      () => popup,
    )).rejects.toThrow("Authorization unavailable");
    expect(popup.close).toHaveBeenCalledOnce();
  });
});
