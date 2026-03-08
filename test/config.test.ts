import assert from "node:assert/strict";
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
