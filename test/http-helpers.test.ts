import assert from "node:assert/strict";
import test from "node:test";

import {
  headerAsString,
  isExcludedPath,
  parseContentLength,
  statusClass,
  toPathname
} from "../src/http-helpers.js";

test("toPathname returns normalized path and falls back on malformed input", () => {
  assert.equal(toPathname("https://example.com/orders/1?x=1"), "/orders/1");
  assert.equal(toPathname("not a valid absolute url"), "/not%20a%20valid%20absolute%20url");
});

test("isExcludedPath supports exact, prefix, and wildcard patterns", () => {
  assert.equal(isExcludedPath("/health", ["/health"]), true);
  assert.equal(isExcludedPath("/health/deep", ["/health"]), true);
  assert.equal(isExcludedPath("/metrics/prometheus", ["/metrics*"]), true);
  assert.equal(isExcludedPath("/orders", ["/health", "/metrics*"]), false);
});

test("headerAsString coerces scalars and arrays", () => {
  assert.equal(headerAsString(undefined), undefined);
  assert.equal(headerAsString(["a", 1, true]), "a,1,true");
  assert.equal(headerAsString(123), "123");
});

test("parseContentLength accepts only finite non-negative numbers", () => {
  assert.equal(parseContentLength("12"), 12);
  assert.equal(parseContentLength("-1"), undefined);
  assert.equal(parseContentLength("NaN"), undefined);
  assert.equal(parseContentLength(undefined), undefined);
});

test("statusClass classifies status code bands", () => {
  assert.equal(statusClass(102), "1xx");
  assert.equal(statusClass(204), "2xx");
  assert.equal(statusClass(302), "3xx");
  assert.equal(statusClass(404), "4xx");
  assert.equal(statusClass(503), "5xx");
});
