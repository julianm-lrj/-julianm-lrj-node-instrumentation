import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfig } from "../src/config.js";
import {
  normalizeRoutePath,
  sanitizeBody,
  sanitizeHeaders,
  sanitizePath,
  sanitizeQueryString,
  sanitizeResponseBody,
  serializeAsAttribute,
  truncateUtf8
} from "../src/redaction.js";

test("sanitizeHeaders removes denied headers and masks sensitive names", () => {
  const config = resolveConfig();

  const headers = sanitizeHeaders(
    {
      authorization: "Bearer token",
      cookie: "session=abc",
      "x-request-id": "abc-123",
      "x-custom-token": "should-not-leak"
    },
    {
      deniedHeaders: config.deniedHeaders,
      redactionPatterns: config.redactionPatterns,
      maxHeaderValueBytes: config.maxHeaderValueBytes
    }
  );

  assert.equal(headers.authorization, undefined);
  assert.equal(headers.cookie, undefined);
  assert.equal(headers["x-request-id"], "abc-123");
  assert.equal(headers["x-custom-token"], undefined);
});

test("sanitizeQueryString masks sensitive query keys", () => {
  const config = resolveConfig();
  const query = sanitizeQueryString("/users?id=100&token=abc123", {
    redactionPatterns: config.redactionPatterns,
    maxUrlBytes: config.maxUrlBytes
  });

  assert.equal(query.value.includes("token=%5BREDACTED%5D"), true);
});

test("sanitizeBody redacts nested json fields", () => {
  const config = resolveConfig();

  const body = sanitizeBody(
    {
      email: "someone@example.com",
      profile: {
        password: "super-secret",
        nested: {
          token: "abc123"
        }
      }
    },
    "application/json",
    {
      allowedBodyTypes: config.allowedBodyTypes,
      redactionPatterns: config.redactionPatterns,
      maxRequestBodyBytes: config.maxRequestBodyBytes,
      captureRequestBody: true
    }
  );

  assert.equal(body.captured, true);
  assert.equal(body.value?.includes("[REDACTED]"), true);
  assert.equal(body.value?.includes("super-secret"), false);
  assert.equal(body.value?.includes("abc123"), false);
});

test("sanitizeHeaders coerces header arrays, nulls, and truncates long values", () => {
  const config = resolveConfig();

  const headers = sanitizeHeaders(
    {
      "x-list": ["a", "b"],
      "x-null": null,
      "x-long": "x".repeat(128)
    },
    {
      deniedHeaders: config.deniedHeaders,
      redactionPatterns: config.redactionPatterns,
      maxHeaderValueBytes: 20
    }
  );

  assert.equal(headers["x-list"], "a,b");
  assert.equal(headers["x-null"], "");
  assert.equal(headers["x-long"]?.includes("[TRUNCATED]"), true);
});

test("truncateUtf8 and sanitizePath handle truncation and malformed paths", () => {
  const truncated = truncateUtf8("hello-world", 5);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.value.includes("[TRUNCATED]"), true);

  const path = sanitizePath("/orders/123/details", 10);
  assert.equal(path.truncated, true);

  const malformed = sanitizePath("http://[::1", 64);
  assert.equal(malformed.value, "/");
});

test("normalizeRoutePath maps dynamic identifiers", () => {
  const normalized = normalizeRoutePath(
    "/users/123/550e8400-e29b-41d4-a716-446655440000/abcdefabcdefabcdef"
  );

  assert.equal(normalized, "/users/:id/:id/:id");
});

test("sanitizeBody handles disabled, unsupported, and form-urlencoded redaction", () => {
  const config = resolveConfig();
  const base = {
    allowedBodyTypes: config.allowedBodyTypes,
    redactionPatterns: config.redactionPatterns,
    maxRequestBodyBytes: 48,
    captureRequestBody: true
  };

  const disabled = sanitizeBody("token=abc", "application/x-www-form-urlencoded", {
    ...base,
    captureRequestBody: false
  });
  assert.equal(disabled.reason, "disabled");

  const unsupported = sanitizeBody("binary", "application/octet-stream", base);
  assert.equal(unsupported.reason, "unsupported-content-type");

  const encoded = sanitizeBody("token=abc&name=julian", "application/x-www-form-urlencoded", base);
  assert.equal(encoded.captured, true);
  assert.equal(encoded.value?.includes("%5BREDACTED%5D"), true);
  assert.equal(encoded.value?.includes("abc"), false);
});

test("sanitizeResponseBody applies content-type checks, redaction, and truncation", () => {
  const config = resolveConfig();
  const base = {
    allowedBodyTypes: config.allowedBodyTypes,
    redactionPatterns: config.redactionPatterns,
      maxResponseBodyBytes: 128,
    captureResponseBody: true
  };

  const disabled = sanitizeResponseBody({ ok: true }, "application/json", {
    ...base,
    captureResponseBody: false
  });
  assert.equal(disabled.reason, "disabled");

  const unsupported = sanitizeResponseBody("raw", "text/plain", base);
  assert.equal(unsupported.reason, "unsupported-content-type");

  const json = sanitizeResponseBody({ secret: "top-secret", ok: true }, "application/json", base);
  assert.equal(json.captured, true);
  assert.equal(json.value?.includes("top-secret"), false);

  const encoded = sanitizeResponseBody("token=abc&ok=true", "application/x-www-form-urlencoded", base);
  assert.equal(encoded.captured, true);
  assert.equal(encoded.value?.includes("%5BREDACTED%5D"), true);
});

test("serializeAsAttribute truncates non-string values", () => {
  const serialized = serializeAsAttribute({ payload: "x".repeat(200) }, 40);
  assert.equal(serialized.includes("[TRUNCATED]"), true);
});
