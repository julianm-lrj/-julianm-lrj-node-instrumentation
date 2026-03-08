import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfig } from "../src/config.js";
import { sanitizeBody, sanitizeHeaders, sanitizeQueryString } from "../src/redaction.js";

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
