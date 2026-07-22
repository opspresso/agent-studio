import { describe, expect, it } from "vitest";
import { assertPublicUrl, SsrfError, type DnsLookup } from "@/infrastructure/net/ssrfGuard";

const resolvesTo = (...addresses: string[]): DnsLookup => async () =>
  addresses.map((address) => ({ address }));

describe("assertPublicUrl scheme handling", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl("ftp://example.com")).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects an unparseable URL", async () => {
    await expect(assertPublicUrl("not a url")).rejects.toBeInstanceOf(SsrfError);
  });
});

describe("assertPublicUrl with IP literals", () => {
  it.each([
    "http://127.0.0.1/",
    "http://10.1.2.3/",
    "http://172.16.5.4/",
    "http://192.168.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:169.254.169.254]/",
  ])("blocks private/reserved literal %s", async (url) => {
    await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(SsrfError);
  });

  it.each(["http://8.8.8.8/", "https://1.1.1.1/", "http://[2606:4700::1]/"])(
    "allows public literal %s",
    async (url) => {
      await expect(assertPublicUrl(url)).resolves.toBeUndefined();
    },
  );
});

describe("assertPublicUrl with hostnames", () => {
  it("allows a host that resolves to a public address", async () => {
    await expect(
      assertPublicUrl("https://api.example.com", resolvesTo("93.184.216.34")),
    ).resolves.toBeUndefined();
  });

  it("blocks a host that resolves to a private address (DNS rebinding)", async () => {
    await expect(
      assertPublicUrl("https://evil.example.com", resolvesTo("10.0.0.5")),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("blocks when ANY resolved address is private", async () => {
    await expect(
      assertPublicUrl("https://mixed.example.com", resolvesTo("93.184.216.34", "127.0.0.1")),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("blocks a host that does not resolve", async () => {
    await expect(
      assertPublicUrl("https://nx.example.com", resolvesTo()),
    ).rejects.toBeInstanceOf(SsrfError);
  });
});
