import assert from "node:assert/strict";
import test from "node:test";

import { createRouter } from "h3";
import { toNodeListener } from "h3/node";

import { instrumentH3Handler, type H3LikeEvent } from "../src/h3.js";
import { startTestServer } from "./test-server.js";

test("h3 instrumented handler supports real request flow", async () => {
  const app = createRouter();

  app.post(
    "/orders/:id",
    instrumentH3Handler(
      async () => ({ ok: true }),
      {
        installSignalHandlers: false,
        requireOtlpTls: false,
        captureRequestBody: true,
        captureResponseBody: true
      }
    ) as never
  );

  const server = await startTestServer(toNodeListener(app));
  try {
    const response = await fetch(`${server.baseUrl}/orders/1?token=abc`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ secret: "top-secret" })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await server.close();
  }
});

test("h3 instrumented handler preserves thrown errors for framework handling", async () => {
  const app = createRouter();

  app.get(
    "/boom",
    instrumentH3Handler(
      async () => {
        throw new Error("boom");
      },
      {
        installSignalHandlers: false,
        requireOtlpTls: false
      }
    ) as never
  );

  const server = await startTestServer(toNodeListener(app));
  try {
    const originalError = console.error;
    console.error = () => {};
    try {
      const response = await fetch(`${server.baseUrl}/boom`);
      assert.equal(response.status, 500);
    } finally {
      console.error = originalError;
    }
  } finally {
    await server.close();
  }
});

test("h3 instrumented handler bypasses excluded paths", async () => {
  const app = createRouter();

  app.get(
    "/health",
    instrumentH3Handler(
      async () => ({ ok: true }),
      {
        installSignalHandlers: false,
        requireOtlpTls: false,
        excludedPaths: ["/health"]
      }
    ) as never
  );

  const server = await startTestServer(toNodeListener(app));
  try {
    const response = await fetch(`${server.baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await server.close();
  }
});

test("h3 instrumentation handles request body from event context without framework helpers", async () => {
  const instrumented = instrumentH3Handler(
    async () => ({ ok: true }),
    {
      installSignalHandlers: false,
      requireOtlpTls: false,
      captureRequestBody: true,
      captureResponseBody: true
    }
  );

  const fakeEvent = {
    node: {
      req: {
        method: "POST",
        url: "/manual",
        headers: {
          "content-type": "application/json"
        }
      },
      res: {
        statusCode: 200,
        getHeader: () => "application/json",
        getHeaders: () => ({})
      }
    },
    context: {
      body: { token: "abc" }
    }
  } as H3LikeEvent;

  const result = await instrumented(fakeEvent);
  assert.deepEqual(result, { ok: true });
});
