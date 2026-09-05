/**
 * Issue #5 — URL/SSRF safety matrix (PRD §32.1 "URL safety" + §21/§29.20).
 */
import { describe, expect, it } from "vitest";
import { validateMonitorUrl } from "../../worker/lib/url-safety";
import { isSensitiveHeaderName } from "../../worker/lib/monitor-schema";

describe("valid URLs", () => {
  it("accepts public https and http URLs, normalized", () => {
    expect(validateMonitorUrl("https://contabilistas.cv/")).toMatchObject({
      ok: true,
      normalized: "https://contabilistas.cv/",
    });
    expect(validateMonitorUrl("http://example.com/health?probe=1")).toMatchObject({
      ok: true,
      normalized: "http://example.com/health?probe=1",
    });
  });

  it("lowercases the host and drops default ports and fragments", () => {
    const result = validateMonitorUrl("https://EXAMPLE.com:443/path#section");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalized).toBe("https://example.com/path");
    }
  });

  it("keeps non-default ports", () => {
    expect(validateMonitorUrl("https://example.com:8443/")).toMatchObject({
      ok: true,
      normalized: "https://example.com:8443/",
    });
  });

  it("allows public IP literals", () => {
    expect(validateMonitorUrl("https://8.8.8.8/dns-query")).toMatchObject({ ok: true });
  });
});

describe("rejected URLs (PRD §32.1)", () => {
  const rejects = (url: string, reasonPart?: string) => {
    const result = validateMonitorUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok && reasonPart) {
      expect(result.reason).toContain(reasonPart);
    }
  };

  it("rejects malformed URLs", () => {
    rejects("not-a-url");
    rejects("https://");
  });

  it("rejects non-http(s) schemes", () => {
    rejects("ftp://example.com/file");
    rejects("file:///etc/passwd");
  });

  it("rejects embedded credentials", () => {
    rejects("https://user:pass@example.com/");
  });

  it("rejects localhost hostnames", () => {
    rejects("http://localhost:3000/");
    rejects("https://api.localhost/");
  });

  it("rejects loopback and private IPv4 literals", () => {
    rejects("http://127.0.0.1:8080/");
    rejects("http://10.1.2.3/");
    rejects("http://192.168.1.10/");
    rejects("http://172.16.0.9/");
    rejects("http://169.254.169.254/latest/meta-data/"); // cloud metadata
    rejects("http://0.0.0.0/");
    rejects("http://100.64.0.1/"); // CGNAT
  });

  it("rejects private/reserved IPv6 literals", () => {
    rejects("http://[::1]/");
    rejects("http://[::]/");
    rejects("http://[fc00::1]/");
    rejects("http://[fe80::1]/");
    rejects("http://[ff02::1]/");
    rejects("http://[::ffff:127.0.0.1]/"); // v4-mapped loopback
  });

  it("rejects numeric-only and hex-encoded host tricks", () => {
    rejects("http://2130706433/"); // 127.0.0.1 as decimal
    rejects("http://0x7f.0.0.1/"); // hex octets
  });

  it("rejects oversized URLs", () => {
    rejects(`https://example.com/${"a".repeat(3000)}`);
  });
});

describe("sensitive header detection (PRD §10.9)", () => {
  it("flags the explicit denylist and secret-bearing patterns", () => {
    for (const name of [
      "Authorization",
      "Proxy-Authorization",
      "Cookie",
      "Set-Cookie",
      "X-API-Key",
      "Api-Key",
      "X-Auth-Token",
      "Secret",
      "X-Password",
      "X-Session-Id",
      "private-key",
    ]) {
      expect(isSensitiveHeaderName(name)).toBe(true);
    }
  });

  it("allows innocuous headers", () => {
    for (const name of ["X-Correlation-Id", "Accept-Language", "X-Monitor-Region"]) {
      expect(isSensitiveHeaderName(name)).toBe(false);
    }
  });
});
