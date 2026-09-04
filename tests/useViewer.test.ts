import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useViewer, ViewerProvider, type Viewer } from "@/app/_lib/useViewer";

const VIEWER: Viewer = {
  email: "viewer@example.com",
  isAdmin: false,
  isConfiguredAdmin: false,
  tier: "member",
};

function ViewerEmail() {
  return createElement("span", null, useViewer()?.email ?? "signed-out");
}

describe("ViewerProvider", () => {
  it("shares the viewer resolved by the root layout", () => {
    expect(
      renderToStaticMarkup(
        createElement(ViewerProvider, {
          viewer: VIEWER,
          children: createElement(ViewerEmail),
        }),
      ),
    ).toBe("<span>viewer@example.com</span>");
  });

  it("keeps a signed-out viewer distinct from a missing provider", () => {
    expect(
      renderToStaticMarkup(
        createElement(ViewerProvider, {
          viewer: null,
          children: createElement(ViewerEmail),
        }),
      ),
    ).toBe("<span>signed-out</span>");
    expect(() => renderToStaticMarkup(createElement(ViewerEmail))).toThrow(
      "useViewer must be used inside ViewerProvider",
    );
  });
});
