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

  it.each([
    "https://user@example.com",
    "https://user:password@example.com",
  ])("rejects embedded credentials in %s", async (url) => {
    await expect(
      assertPublicUrl(url, resolvesTo("93.184.216.34")),
    ).rejects.toThrow("URL credentials are not allowed");
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

  // Every one of these is an internal address written as IPv6. The mapped form
  // was the only spelling the guard read, so the rest reached the network.
  it.each([
    "http://[::7f00:1]/", // IPv4-compatible ::127.0.0.1
    "http://[::a9fe:a9fe]/", // IPv4-compatible ::169.254.169.254
    "http://[64:ff9b::7f00:1]/", // NAT64 to 127.0.0.1
    "http://[64:ff9b::a00:1]/", // NAT64 to 10.0.0.1
    "http://[2002:a00:1::]/", // 6to4 carrying 10.0.0.1
    "http://[ff02::1]/", // link-local all-nodes multicast
    "http://[fd12:3456::1]/", // unique local, fd half of fc00::/7
    "http://[2001:db8::1]/", // documentation
    "http://[100::1]/", // discard-only
  ])("blocks an internal address spelled as IPv6: %s", async (url) => {
    await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(SsrfError);
  });

  // The transition prefixes are judged by the IPv4 inside them, not refused
  // wholesale: an IPv6-only deployment reaches the public internet through one.
  it.each([
    "http://[64:ff9b::8.8.8.8]/", // NAT64 to a public address
    "http://[2002:808:808::]/", // 6to4 carrying 8.8.8.8
  ])("allows a public address spelled as IPv6: %s", async (url) => {
    await expect(assertPublicUrl(url)).resolves.toBeUndefined();
  });

  it("blocks an IPv6 address a resolver returns uncompressed", async () => {
    await expect(
      assertPublicUrl("https://evil.example.com", resolvesTo("0:0:0:0:0:ffff:127.0.0.1")),
    ).rejects.toBeInstanceOf(SsrfError);
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

  it("preserves a DNS resolver failure instead of reporting a blocked host", async () => {
    const unavailable = new Error("resolver unavailable");
    await expect(assertPublicUrl("https://api.example.com", async () => { throw unavailable; }))
      .rejects.toBe(unavailable);
  });
});
