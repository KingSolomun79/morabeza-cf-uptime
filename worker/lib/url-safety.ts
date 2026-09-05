/**
 * URL and SSRF safety for monitor targets (issues #5; PRD §21, §29.20).
 *
 * Monitor URLs are untrusted input even though admins are Access-gated.
 * V1 rules: http/https only; no embedded credentials; no localhost/loopback
 * hostnames; no private/reserved/link-local IP literals (v4 + v6); no
 * numeric-only or hex-encoded host tricks; length caps; normalization.
 * The checker (#6) re-checks scheme as defense in depth.
 */

export const MAX_URL_LENGTH = 2048;

export interface UrlSafetyOk {
  ok: true;
  /** Normalized absolute URL (lowercased host, no fragment, default port removed). */
  normalized: string;
}

export interface UrlSafetyError {
  ok: false;
  reason: string;
}

export type UrlSafetyResult = UrlSafetyOk | UrlSafetyError;

function fail(reason: string): UrlSafetyError {
  return { ok: false, reason };
}

// ---------------------------------------------------------------------------
// IPv4 / IPv6 helpers

const PRIVATE_V4_RANGES: Array<[number, number]> = [
  // [start, end] as unsigned 32-bit ints, inclusive
  [0x00000000, 0x00ffffff], // 0.0.0.0/8        "this network"
  [0x0a000000, 0x0affffff], // 10.0.0.0/8        private
  [0x64400000, 0x647fffff], // 100.64.0.0/10     CGNAT
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8       loopback
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16    link-local
  [0xac100000, 0xac1fffff], // 172.16.0.0/12     private
  [0xc0000000, 0xc00000ff], // 192.0.0.0/24      reserved
  [0xc0000200, 0xc00002ff], // 192.0.2.0/24      TEST-NET-1
  [0xc0580000, 0xc05800ff], // 192.88.99.0/24    6to4 relay (deprecated)
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16    private
  [0xc6120000, 0xc613ffff], // 198.18.0.0/15     benchmarking
  [0xc6336400, 0xc63364ff], // 198.51.100.0/24   TEST-NET-2
  [0xcb007100, 0xcb0071ff], // 203.0.113.0/24    TEST-NET-3
  [0xe0000000, 0xefffffff], // 224.0.0.0/4       multicast
  [0xf0000000, 0xffffffff], // 240.0.0.0/4       reserved + broadcast
];

function ipv4ToInt(dotted: string): number | null {
  const parts = dotted.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function isPrivateV4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  return PRIVATE_V4_RANGES.some(([start, end]) => value >= start && value <= end);
}

/** Expands an IPv6 address to eight 16-bit groups (as numbers). */
function expandIpv6(address: string): number[] | null {
  let text = address.toLowerCase();
  if (text.includes("%")) text = text.split("%")[0]; // zone id
  const doubleColonCount = (text.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;

  let head: string[];
  let tail: string[];
  if (text.includes("::")) {
    const [left, right = ""] = text.split("::");
    head = left === "" ? [] : left.split(":");
    tail = right === "" ? [] : right.split(":");
  } else {
    head = text.split(":");
    tail = head;
  }

  const ipv4Tail = tail.length > 0 && tail[tail.length - 1].includes(".");
  const headGroups = head.map((group) => {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return -1;
    return parseInt(group, 16);
  });
  if (headGroups.includes(-1)) return null;

  let tailGroups: number[];
  if (ipv4Tail) {
    const mapped = ipv4ToInt(tail[tail.length - 1]);
    if (mapped === null) return null;
    const embedded = [(mapped & 0xffff0000) >>> 16, mapped & 0xffff];
    const prefix = tail.slice(0, -1).map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : -1));
    if (prefix.includes(-1)) return null;
    tailGroups = [...prefix, ...embedded];
  } else {
    tailGroups = tail.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : -1));
    if (tailGroups.includes(-1)) return null;
  }

  const groups = [...headGroups, ...tailGroups];
  if (groups.length > 8) return null;
  if (groups.length < 8) {
    if (!text.includes("::")) return null;
    groups.splice(headGroups.length, 0, ...new Array(8 - groups.length).fill(0));
  }
  return groups;
}

function isPrivateV6(groups: number[]): boolean {
  const zeros = (count: number, offset: number): boolean =>
    groups.slice(offset, offset + count).every((group) => group === 0);
  const first = groups[0];
  // Unspecified :: and loopback ::1
  if (zeros(8, 0) || (groups[0] === 0 && zeros(6, 1) && groups[7] === 1)) return true;
  // Unique local fc00::/7 → fc00..fdff
  if (first >= 0xfc00 && first <= 0xfdff) return true;
  // Link-local fe80::/10
  if (first >= 0xfe80 && first <= 0xfebf) return true;
  // Multicast ff00::/8
  if (first >= 0xff00 && first <= 0xffff) return true;
  // IPv4-mapped ::ffff:0:0/96 — check embedded v4
  if (zeros(5, 0) && groups[5] === 0xffff) {
    const v4 = `${(groups[6] >> 8).toString()}.${(groups[6] & 0xff).toString()}.${(groups[7] >> 8).toString()}.${(groups[7] & 0xff).toString()}`;
    return isPrivateV4(v4);
  }
  // Documenting-only ranges (2001:db8::/32)
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;
  return false;
}

// ---------------------------------------------------------------------------

function isIpLiteralHostname(hostname: string): boolean {
  // IPv4 dotted quad
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  // Bracketed or bare IPv6 (contains colons)
  if (hostname.includes(":")) return true;
  // All-numeric single label (e.g. 2130706433 == 127.0.0.1)
  if (/^\d+$/.test(hostname)) return true;
  // Hex-ish octet tricks (0x7f.0.0.1)
  if (/^0x[0-9a-f]+(\.0x[0-9a-f]+){0,3}$/i.test(hostname)) return true;
  return false;
}

export function validateMonitorUrl(raw: string): UrlSafetyResult {
  if (raw.length > MAX_URL_LENGTH) {
    return fail(`url exceeds ${MAX_URL_LENGTH} characters`);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("url is malformed");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail("only http: and https: schemes are allowed");
  }

  if (url.username !== "" || url.password !== "") {
    return fail("embedded credentials are not allowed");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return fail("localhost hostnames are not allowed");
  }

  if (isIpLiteralHostname(hostname)) {
    if (hostname.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
      // Genuine IP literal — evaluate it.
      if (hostname.includes(":")) {
        const groups = expandIpv6(hostname);
        if (groups === null) return fail("malformed IPv6 address");
        if (isPrivateV6(groups)) return fail("private/reserved IPv6 addresses are not allowed");
      } else if (isPrivateV4(hostname)) {
        return fail("private/reserved IP addresses are not allowed");
      }
      // Public IP literal: fall through (monitoring an IP is legitimate).
    } else {
      // Numeric / hex-encoded host trick.
      return fail("numeric or hex-encoded hostnames are not allowed");
    }
  }

  // Normalize: lowercase host, drop default port, drop fragment.
  const port = url.port;
  const normalizedPort =
    (url.protocol === "https:" && port === "443") || (url.protocol === "http:" && port === "80")
      ? ""
      : port;
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.port = normalizedPort;
  url.hash = "";

  return { ok: true, normalized: url.toString() };
}
