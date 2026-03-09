import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveConfig } from "../src/config.js";

test("resolveConfig clamps sampling rate and parses booleans", () => {
  const config = resolveConfig(
    {},
    {
      INSTRUMENTATION_TRACE_SAMPLING_RATE: "1.8",
      INSTRUMENTATION_CAPTURE_HEADERS: "false",
      INSTRUMENTATION_CAPTURE_REQUEST_BODY: "true"
    }
  );

  assert.equal(config.traceSamplingRate, 1);
  assert.equal(config.captureHeaders, false);
  assert.equal(config.captureRequestBody, true);
});

test("resolveConfig reads denied headers and allowed body types", () => {
  const config = resolveConfig(
    {},
    {
      INSTRUMENTATION_ALLOWED_BODY_TYPES: "application/json,text/plain",
      INSTRUMENTATION_DENIED_HEADERS: "authorization,cookie,*secret*"
    }
  );

  assert.deepEqual(config.allowedBodyTypes, ["application/json", "text/plain"]);
  assert.deepEqual(config.deniedHeaders, ["authorization", "cookie", "*secret*"]);
});

test("resolveConfig disables OTLP TLS when allow-insecure CLI flag is present", () => {
  const config = resolveConfig({}, {}, ["node", "server.js", "--allow-insecure-otlp"]);
  assert.equal(config.requireOtlpTls, false);
});

test("resolveConfig env setting overrides allow-insecure CLI flag", () => {
  const config = resolveConfig(
    {},
    { INSTRUMENTATION_REQUIRE_OTLP_TLS: "true" },
    ["node", "server.js", "--allow-insecure-otlp"]
  );

  assert.equal(config.requireOtlpTls, true);
});

test("resolveConfig falls back to nearest package.json version", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };

  assert.equal(typeof packageJson.version, "string");

  const config = resolveConfig({}, {});
  assert.equal(config.serviceVersion, packageJson.version);
});

test("resolveConfig honors npm_package_version over package.json fallback", () => {
  const config = resolveConfig({}, { npm_package_version: "9.9.9" });
  assert.equal(config.serviceVersion, "9.9.9");
});

test("resolveConfig parses OTLP headers and insecure OTLP env toggle", () => {
  const config = resolveConfig(
    {},
    {
      INSTRUMENTATION_ALLOW_INSECURE_OTLP: "true",
      OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=abc123, malformed, empty=, tenant=acme"
    }
  );

  assert.equal(config.requireOtlpTls, false);
  assert.deepEqual(config.otlpHeaders, {
    "x-api-key": "abc123",
    tenant: "acme"
  });
});

test("resolveConfig parses redaction patterns from env regex and literals", () => {
  const config = resolveConfig(
    {},
    {
      INSTRUMENTATION_REDACTION_PATTERNS: "/foo.*/i,custom.secret"
    }
  );

  assert.equal(config.redactionPatterns.some((pattern) => pattern.test("foo-token")), true);
  assert.equal(config.redactionPatterns.some((pattern) => pattern.test("custom.secret")), true);
});
