/**
 * SSRF guard for operator-registered outbound URLs (MCP servers, external
 * agents). Rejects non-http(s) schemes and hosts that resolve to private,
 * loopback, link-local (incl. the 169.254.169.254 cloud metadata address), or
 * otherwise reserved ranges.
 *
 * The DNS resolver is injectable so the check stays deterministic in tests. The
 * guard is applied both at registration and at dispatch; the dispatch check
 * narrows (but cannot fully close) the DNS-rebinding window between the two.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

export type DnsLookup = (host: string) => Promise<{ address: string }[]>;

const defaultLookup: DnsLookup = (host) => lookup(host, { all: true });

/** [baseCidr, prefixBits] for IPv4 ranges that must never be dispatched to. */
const BLOCKED_IPV4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function ipv4ToLong(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inCidr(ipLong: number, baseIp: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipLong & mask) === (ipv4ToLong(baseIp) & mask);
}

function isBlockedIpv4(ip: string): boolean {
  const ipLong = ipv4ToLong(ip);
  return BLOCKED_IPV4.some(([base, bits]) => inCidr(ipLong, base, bits));
}

/**
 * The eight 16-bit groups of an IPv6 literal, or `null` when the text is not
 * one this can read — which {@link isBlockedAddress} treats as unsafe.
 *
 * Written out rather than pattern-matched on the text because an IPv6 address
 * has many spellings of the same value: `::`, a dotted IPv4 tail, and a
 * resolver or URL parser that compresses differently than the operator typed.
 * Prefix tests below compare numbers, so every spelling reaches the same answer.
 */
function ipv6Groups(ip: string): number[] | null {
  if (isIP(ip) !== 6) {
    return null;
  }
  const halves = ip.toLowerCase().split("::");
  if (halves.length > 2) {
    return null;
  }
  const expand = (part: string): number[] => {
    if (part === "") {
      return [];
    }
    const pieces = part.split(":");
    const tail = pieces[pieces.length - 1] ?? "";
    if (!tail.includes(".")) {
      return pieces.map((piece) => parseInt(piece, 16));
    }
    // A dotted IPv4 tail (`::ffff:127.0.0.1`) is the low two groups.
    const octets = tail.split(".").map(Number);
    return [
      ...pieces.slice(0, -1).map((piece) => parseInt(piece, 16)),
      ((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
      ((octets[2] ?? 0) << 8) | (octets[3] ?? 0),
    ];
  };
  const head = expand(halves[0] ?? "");
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const tail = expand(halves[1] ?? "");
  const fill = 8 - head.length - tail.length;
  return fill < 0 ? null : [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function inIpv6Cidr(groups: number[], base: readonly number[], bits: number): boolean {
  for (let index = 0; index < 8; index += 1) {
    const remaining = bits - index * 16;
    if (remaining <= 0) {
      return true;
    }
    const mask = remaining >= 16 ? 0xffff : (0xffff << (16 - remaining)) & 0xffff;
    if (((groups[index] ?? 0) & mask) !== ((base[index] ?? 0) & mask)) {
      return false;
    }
  }
  return true;
}

/** Parsed once; the prefixes below are literals this file owns. */
function prefix(ip: string, bits: number): { base: readonly number[]; bits: number } {
  const base = ipv6Groups(ip);
  if (!base) {
    throw new Error(`ssrfGuard: ${ip} is not an IPv6 prefix`);
  }
  return { base, bits };
}

/**
 * IPv6 ranges that must never be dispatched to — the IPv4 list's counterpart.
 * Multicast is here for the same reason `224.0.0.0/4` is there, and Teredo is
 * a tunnel to an IPv4 address this guard would otherwise never see.
 */
const BLOCKED_IPV6 = [
  prefix("100::", 64), // discard-only
  prefix("2001::", 32), // Teredo
  prefix("2001:db8::", 32), // documentation
  prefix("fc00::", 7), // unique local
  prefix("fe80::", 10), // link-local
  prefix("ff00::", 8), // multicast
];

/**
 * IPv6 prefixes that carry an IPv4 address, and the group it starts at.
 *
 * Judged by the address *inside* them rather than blocked wholesale, because
 * these are how an IPv6-only network — which is what a deployment inside a
 * modern enterprise may well be — reaches IPv4 at all: `64:ff9b::8.8.8.8` is an
 * ordinary public address there, and `64:ff9b::10.0.0.1` is exactly the request
 * this guard exists to refuse. Only the mapped form was read before, so every
 * other spelling of an internal address went through unexamined.
 *
 * `::/96` covers the unspecified and loopback addresses as well: their embedded
 * IPv4 is in `0.0.0.0/8`, which the IPv4 list already refuses.
 */
const EMBEDDED_IPV4 = [
  { ...prefix("::", 96), at: 6 }, // IPv4-compatible (RFC 4291, deprecated)
  { ...prefix("::ffff:0:0", 96), at: 6 }, // IPv4-mapped
  { ...prefix("64:ff9b::", 96), at: 6 }, // NAT64 well-known prefix (RFC 6052)
  { ...prefix("2002::", 16), at: 1 }, // 6to4 (RFC 3056)
];

function isBlockedIpv6(ip: string): boolean {
  const groups = ipv6Groups(ip);
  if (!groups) {
    return true;
  }
  for (const { base, bits, at } of EMBEDDED_IPV4) {
    if (inIpv6Cidr(groups, base, bits)) {
      const high = groups[at] ?? 0;
      const low = groups[at + 1] ?? 0;
      return isBlockedIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
    }
  }
  return BLOCKED_IPV6.some(({ base, bits }) => inIpv6Cidr(groups, base, bits));
}

function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    return isBlockedIpv4(ip);
  }
  if (family === 6) {
    return isBlockedIpv6(ip);
  }
  return true; // unparseable → treat as unsafe
}

/**
 * Throw {@link SsrfError} if `rawUrl` is not an http(s) URL whose host resolves
 * exclusively to public addresses.
 */
export async function resolvePublicUrl(
  rawUrl: string,
  dnsLookup: DnsLookup = defaultLookup,
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`Unsupported URL scheme: ${url.protocol.replace(":", "")}`);
  }
  if (url.username || url.password) {
    throw new SsrfError("URL credentials are not allowed");
  }

  const host = url.hostname;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  let addresses: string[];
  if (isIP(bare)) {
    addresses = [bare];
  } else {
    const resolved = await dnsLookup(bare);
    if (resolved.length === 0) {
      throw new SsrfError(`Cannot resolve host: ${host}`);
    }
    addresses = resolved.map((entry) => entry.address);
  }

  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new SsrfError(`URL host resolves to a private or reserved address: ${host}`);
    }
  }
  return { url, addresses };
}

export async function assertPublicUrl(
  rawUrl: string,
  dnsLookup: DnsLookup = defaultLookup,
): Promise<void> {
  await resolvePublicUrl(rawUrl, dnsLookup);
}
