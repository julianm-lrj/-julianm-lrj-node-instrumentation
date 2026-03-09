import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import { startTelemetry } from "../src/telemetry.js";

test("startTelemetry shutdown is idempotent", async () => {
  const runtime = startTelemetry({
    installSignalHandlers: false,
    requireOtlpTls: false,
    traceSamplingRate: 0
  });

  await Promise.all([runtime.shutdown(), runtime.shutdown()]);
});

test("startTelemetry auto-disables all signals when no OTLP endpoints are configured", async () => {
  const infos: string[] = [];
  const warnings: string[] = [];

  const originalInfo = console.info;
  const originalWarn = console.warn;

  console.info = (...args: unknown[]) => {
    infos.push(args.map((value) => String(value)).join(" "));
  };

  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((value) => String(value)).join(" "));
  };

  try {
    const runtime = startTelemetry({
      installSignalHandlers: false,
      otlpEndpoint: "",
      otlpTracesEndpoint: "",
      otlpMetricsEndpoint: "",
      otlpLogsEndpoint: ""
    });

    await runtime.shutdown();
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
  }

  const disableMessage = infos.find((line) =>
    line.includes("OTLP export disabled for signals without a valid endpoint")
  );

  assert.ok(disableMessage);
  assert.equal(disableMessage.includes("trace"), true);
  assert.equal(disableMessage.includes("metric"), true);
  assert.equal(disableMessage.includes("log"), true);
  assert.equal(warnings.some((line) => line.includes("OTLP endpoint is not TLS")), false);
});

test("startTelemetry auto-disables only missing OTLP signal endpoints", async () => {
  const infos: string[] = [];
  const originalInfo = console.info;

  console.info = (...args: unknown[]) => {
    infos.push(args.map((value) => String(value)).join(" "));
  };

  try {
    const runtime = startTelemetry({
      installSignalHandlers: false,
      otlpEndpoint: "",
      otlpTracesEndpoint: "https://collector.example.test/v1/traces",
      otlpMetricsEndpoint: "",
      otlpLogsEndpoint: ""
    });

    await runtime.shutdown();
  } finally {
    console.info = originalInfo;
  }

  const disableMessage = infos.find((line) =>
    line.includes("OTLP export disabled for signals without a valid endpoint")
  );

  assert.ok(disableMessage);
  assert.equal(disableMessage.includes("trace"), false);
  assert.equal(disableMessage.includes("metric"), true);
  assert.equal(disableMessage.includes("log"), true);
});

test("startTelemetry warns when insecure OTLP URL is used with TLS requirement", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((value) => String(value)).join(" "));
  };

  try {
    const runtime = startTelemetry({
      installSignalHandlers: false,
      requireOtlpTls: true,
      otlpEndpoint: "http://127.0.0.1:4318"
    });

    await runtime.shutdown();
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.some((line) => line.includes("OTLP endpoint is not TLS")), true);
});

test("startTelemetry installs and removes process signal handlers", async () => {
  const attachedSignals: string[] = [];
  const detachedSignals: string[] = [];

  const originalOn = process.on.bind(process);
  const originalOff = process.off.bind(process);

  const processMutable = process as NodeJS.Process & {
    on: NodeJS.Process["on"];
    off: NodeJS.Process["off"];
  };

  processMutable.on = ((event: NodeJS.Signals | string, listener: (...args: unknown[]) => void) => {
    if (typeof event === "string") {
      attachedSignals.push(event);
    }
    return originalOn(event as NodeJS.Signals, listener as (...args: never[]) => void);
  }) as NodeJS.Process["on"];

  processMutable.off = ((event: NodeJS.Signals | string, listener: (...args: unknown[]) => void) => {
    if (typeof event === "string") {
      detachedSignals.push(event);
    }
    return originalOff(event as NodeJS.Signals, listener as (...args: never[]) => void);
  }) as NodeJS.Process["off"];

  try {
    const runtime = startTelemetry({
      installSignalHandlers: true,
      requireOtlpTls: false,
      traceSamplingRate: 0
    });

    await runtime.shutdown();
  } finally {
    processMutable.on = originalOn as NodeJS.Process["on"];
    processMutable.off = originalOff as NodeJS.Process["off"];
  }

  assert.equal(attachedSignals.includes("SIGTERM"), true);
  assert.equal(attachedSignals.includes("SIGINT"), true);
  assert.equal(detachedSignals.includes("SIGTERM"), true);
  assert.equal(detachedSignals.includes("SIGINT"), true);
});
