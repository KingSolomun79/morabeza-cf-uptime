/**
 * Issue #23 — monitor form logic (PRD §10, §22): the client-side pre-flight
 * MUST agree with the shared API schema (single source of truth), parse form
 * strings into typed config, and prefill edit/duplicate forms losslessly.
 * Node environment: pure functions, no DOM.
 */
import { describe, expect, it } from "vitest";
import {
  emptyMonitorFormValues,
  formValuesToConfigInput,
  monitorToFormValues,
  POST_METHOD_WARNING,
  validateMonitorConfig,
} from "../../src/lib/monitor-form";
import type { MonitorDto } from "../../src/types/monitor";

function validConfigInput() {
  return formValuesToConfigInput({
    ...emptyMonitorFormValues(),
    clientId: "cli_1",
    name: "Alpha Site",
    url: "https://Example.com/health#frag",
    expectedStatusCodes: "200, 204",
    headers: [{ name: "X-Probe", value: "morabeza" }],
    tags: "prod, edge",
  });
}

describe("formValuesToConfigInput (PRD §22 field parsing)", () => {
  it("parses numbers, status-code lists, tags, and headers from raw strings", () => {
    const input = validConfigInput();
    expect(input).toMatchObject({
      clientId: "cli_1",
      name: "Alpha Site",
      intervalSeconds: 300,
      timeoutMs: 10000,
      failureThreshold: 3,
      recoveryThreshold: 2,
      expectedStatusCodes: [200, 204],
      headers: { "X-Probe": "morabeza" },
      tags: ["prod", "edge"],
      bodyContains: null,
      maxResponseTimeMs: null,
      cacheBust: false,
    });
  });

  it("treats empty optional fields as explicit nulls and drops blank header rows", () => {
    const values = emptyMonitorFormValues();
    values.clientId = "cli_1";
    values.name = "n";
    values.url = "https://example.com";
    values.headers = [
      { name: "", value: "" },
      { name: "X-Keep", value: "1" },
    ];
    const input = formValuesToConfigInput(values);
    expect(input.bodyContains).toBeNull();
    expect(input.bodyNotContains).toBeNull();
    expect(input.maxResponseTimeMs).toBeNull();
    expect(input.requestBody).toBeNull();
    expect(input.tags).toBeNull();
    expect(input.headers).toEqual({ "X-Keep": "1" });
  });
});

describe("validateMonitorConfig — the shared §22 matrix", () => {
  it("accepts a fully valid config and returns the schema-transformed value", () => {
    const validation = validateMonitorConfig(validConfigInput());
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      // Normalization comes from the API's own schema (host lowercased, fragment dropped).
      expect(validation.input.url).toBe("https://example.com/health");
      expect(validation.input.method).toBe("GET");
    }
  });

  it("rejects a missing client, empty name, and disallowed targets with field errors", () => {
    const validation = validateMonitorConfig(formValuesToConfigInput(emptyMonitorFormValues()));
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.errors.clientId).toMatch(/client is required/);
      expect(typeof validation.errors.name).toBe("string");
      expect(typeof validation.errors.url).toBe("string");
    }
  });

  it("rejects private/localhost URLs (PRD §29.20 via the shared url-safety)", () => {
    const input = validConfigInput();
    input.url = "http://localhost:8080/health";
    const validation = validateMonitorConfig(input);
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.errors.url).toMatch(/not an allowed public http/);
  });

  it("rejects intervals outside the §10.3 choices", () => {
    const values = emptyMonitorFormValues();
    values.clientId = "cli_1";
    values.name = "n";
    values.url = "https://example.com";
    values.intervalSeconds = "90";
    const validation = validateMonitorConfig(formValuesToConfigInput(values));
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.errors.intervalSeconds).toMatch(/60, 120, 300, or 600/);
  });

  it("rejects an empty expected-status list (§10.2: one or more)", () => {
    const input = validConfigInput();
    input.expectedStatusCodes = [];
    const validation = validateMonitorConfig(input);
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.errors.expectedStatusCodes).toMatch(/at least one/);
  });

  it("maps non-numeric status tokens to a field error instead of crashing", () => {
    const values = emptyMonitorFormValues();
    values.clientId = "cli_1";
    values.name = "n";
    values.url = "https://example.com";
    values.expectedStatusCodes = "200, abc";
    const validation = validateMonitorConfig(formValuesToConfigInput(values));
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.errors.expectedStatusCodes).toBeDefined();
  });

  it("rejects security-sensitive header names inline (PRD §10.9)", () => {
    const input = validConfigInput();
    input.headers = { Authorization: "Bearer nope" };
    const validation = validateMonitorConfig(input);
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.errors.headers).toMatch(/"Authorization".*§10\.9/);
  });

  it("rejects a request body on non-POST monitors (shared conflict rule)", () => {
    const input = validConfigInput();
    input.requestBody = "hello=world";
    const validation = validateMonitorConfig(input);
    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.errors.requestBody).toMatch(/only allowed for POST/);
  });

  it("enforces §10.4/§10.5 threshold and timeout bounds", () => {
    const input = validConfigInput();
    input.failureThreshold = 11;
    input.timeoutMs = 500;
    const validation = validateMonitorConfig(input);
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.errors.failureThreshold).toBeDefined();
      expect(validation.errors.timeoutMs).toBeDefined();
    }
  });
});

function fixtureMonitor(): MonitorDto {
  return {
    id: "mon_1",
    clientId: "cli_1",
    name: "Alpha Site",
    url: "https://example.com/health",
    method: "POST",
    headers: { "X-Probe": "morabeza" },
    requestBody: "ping=1",
    expectedStatusCodes: [200, 204],
    bodyContains: "ok",
    bodyNotContains: null,
    maxResponseTimeMs: 2000,
    intervalSeconds: 120,
    timeoutMs: 5000,
    failureThreshold: 2,
    recoveryThreshold: 1,
    cacheBust: true,
    enabled: true,
    tags: ["prod"],
    nextCheckAt: "2026-09-06T10:00:00.000Z",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-06T10:00:00.000Z",
    archivedAt: null,
    state: { status: "up", lastCheckedAt: null, lastStatusCode: 200, lastResponseTimeMs: 120, lastReasonCode: null },
  };
}

describe("monitorToFormValues — edit + duplicate prefill", () => {
  it("round-trips a monitor config through the form losslessly", () => {
    const values = monitorToFormValues(fixtureMonitor(), "edit");
    expect(values.name).toBe("Alpha Site");
    expect(values.expectedStatusCodes).toBe("200, 204");
    expect(values.headers).toEqual([{ name: "X-Probe", value: "morabeza" }]);
    expect(values.tags).toBe("prod");
    expect(values.maxResponseTimeMs).toBe("2000");

    const validation = validateMonitorConfig(formValuesToConfigInput(values));
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.input).toMatchObject({
        url: "https://example.com/health",
        method: "POST",
        intervalSeconds: 120,
        timeoutMs: 5000,
        failureThreshold: 2,
        recoveryThreshold: 1,
        cacheBust: true,
        requestBody: "ping=1",
      });
    }
  });

  it("marks duplicate prefill with a (copy) suffix so create re-validates cleanly", () => {
    const values = monitorToFormValues(fixtureMonitor(), "duplicate");
    expect(values.name).toBe("Alpha Site (copy)");
    // Everything else is identical to the source config.
    expect(values.url).toBe(fixtureMonitor().url);
    expect(values.headers).toEqual([{ name: "X-Probe", value: "morabeza" }]);
  });

  it("normalizes nulls from a sparse monitor (new-style rows)", () => {
    const sparse = { ...fixtureMonitor(), headers: null, tags: null, maxResponseTimeMs: null };
    const values = monitorToFormValues(sparse, "edit");
    expect(values.headers).toEqual([]);
    expect(values.tags).toBe("");
    expect(values.maxResponseTimeMs).toBe("");
  });

  it("carries the §10.1 POST warning text", () => {
    expect(POST_METHOD_WARNING).toMatch(/more than once/);
  });
});
