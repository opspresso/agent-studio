import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { blockCrossSiteDEV } from "next/dist/server/lib/router-utils/block-cross-site-dev";
import nextConfig from "../next.config";

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });

function checkOrigin(origin: string) {
  const request = { url: "/_next/webpack-hmr", headers: { origin } } as IncomingMessage;
  const response = { statusCode: 200, end: vi.fn() };
  const blocked = blockCrossSiteDEV(request, response as unknown as ServerResponse, nextConfig.allowedDevOrigins, undefined);
  return { blocked, response };
}

describe("Next.js development WebSocket origins", () => {
  it.each(["http://localhost:3000", "http://localhost:4200", "http://127.0.0.1:3000", "http://127.0.0.1:4200"])(
    "allows local browser initialization from %s", origin => {
      const { blocked, response } = checkOrigin(origin);
      expect(blocked).toBe(false);
      expect(response.end).not.toHaveBeenCalled();
    },
  );

  it.each(["http://127.0.0.1.attacker.test:3000", "http://192.168.1.9:3000", "null"])(
    "refuses an unapproved or opaque origin %s", origin => {
      const { blocked, response } = checkOrigin(origin);
      expect(blocked).toBe(true);
      expect(response.statusCode).toBe(403);
      expect(response.end).toHaveBeenCalledExactlyOnceWith("Unauthorized");
    },
  );
});
