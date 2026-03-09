import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

import { createExpressInstrumentationMiddleware } from "../src/express.js";
import { startTestServer } from "./test-server.js";

test("Express middleware preserves normal request/response flow", async () => {
  const app = express();
  app.use(express.json());
  app.use(
    createExpressInstrumentationMiddleware({
      installSignalHandlers: false,
      requireOtlpTls: false,
      captureResponseBody: true,
      maxResponseBodyBytes: 256
    })
  );

  app.post("/orders/:id", (req, res) => {
    res.status(201).json({
      ok: true,
      id: req.params.id,
      received: req.body
    });
  });

  const server = await startTestServer(app);
  try {
    const response = await fetch(`${server.baseUrl}/orders/42?token=abc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "req-42"
      },
      body: JSON.stringify({ name: "julian", secret: "top-secret" })
    });

    assert.equal(response.status, 201);

    const payload = (await response.json()) as {
      ok: boolean;
      id: string;
      received: { name: string; secret: string };
    };

    assert.equal(payload.ok, true);
    assert.equal(payload.id, "42");
    assert.equal(payload.received.name, "julian");
  } finally {
    await server.close();
  }
});

test("Express middleware bypasses excluded paths", async () => {
  const app = express();
  app.use(
    createExpressInstrumentationMiddleware({
      installSignalHandlers: false,
      requireOtlpTls: false,
      excludedPaths: ["/health"]
    })
  );

  app.get("/health", (_req, res) => {
    res.status(204).end();
  });

  const server = await startTestServer(app);
  try {
    const response = await fetch(`${server.baseUrl}/health`);
    assert.equal(response.status, 204);
  } finally {
    await server.close();
  }
});

test("Express middleware fails open when instrumentation throws", async () => {
  const middleware = createExpressInstrumentationMiddleware({
    installSignalHandlers: false,
    requireOtlpTls: false
  });

  let nextCalled = false;
  middleware(
    {
      get originalUrl() {
        throw new Error("synthetic instrumentation failure");
      },
      url: "/fail-open",
      method: "GET",
      headers: {}
    } as never,
    {} as never,
    () => {
      nextCalled = true;
    }
  );

  assert.equal(nextCalled, true);
});

test("Express middleware handles streamed 5xx responses", async () => {
  const app = express();
  app.use(
    createExpressInstrumentationMiddleware({
      installSignalHandlers: false,
      requireOtlpTls: false,
      captureResponseBody: true,
      maxResponseBodyBytes: 256
    })
  );

  app.get("/stream-error", (_req, res) => {
    res.status(500);
    res.setHeader("content-type", "application/json");
    res.write(Buffer.from('{"ok":'));
    res.end("false}");
  });

  const server = await startTestServer(app);
  try {
    const response = await fetch(`${server.baseUrl}/stream-error`);
    assert.equal(response.status, 500);
    assert.equal(await response.text(), '{"ok":false}');
  } finally {
    await server.close();
  }
});
