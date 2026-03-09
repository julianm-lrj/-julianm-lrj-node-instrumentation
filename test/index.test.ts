import assert from "node:assert/strict";
import test from "node:test";

import * as api from "../src/index.js";

test("index exports core public APIs", () => {
  assert.equal(typeof api.resolveConfig, "function");
  assert.equal(typeof api.startTelemetry, "function");
  assert.equal(typeof api.createExpressInstrumentationMiddleware, "function");
  assert.equal(typeof api.instrumentH3Handler, "function");
  assert.equal(typeof api.sanitizeHeaders, "function");
  assert.equal(typeof api.sanitizeBody, "function");
});
