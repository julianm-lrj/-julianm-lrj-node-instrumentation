# @julianm-lrj/node-instrumentation

Production-focused OpenTelemetry instrumentation helpers for Node services.

## Features
- Node `>=20.6.0` policy-aligned configuration.
- Traces, metrics, and logs with OTLP exporters.
- Express middleware with request/response telemetry capture.
- h3 handler wrapper with equivalent telemetry behavior.
- Capture-all-except-denylist headers, content-type body filtering, recursive redaction, and truncation markers.
- Environment-driven sampling and capture controls.
- `service.version` defaults to the nearest `package.json` version (or env overrides).

## Install

```bash
npm install @julianm-lrj/node-instrumentation
```

## Runtime Support
- Minimum supported Node.js version: `20.6.0`
- Continuously validated in CI on Node `20.x` and `24.x`

## Quality Gates
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run test:coverage` (fails below `90%` line coverage and writes `coverage/lcov.info`)

## Start OpenTelemetry

```ts
import { startTelemetry } from "@julianm-lrj/node-instrumentation";

const telemetry = startTelemetry({
  serviceName: "payments-api",
  deploymentEnvironment: "production",
  requireOtlpTls: true
});

// Optional explicit shutdown if your process manager does not send signals.
await telemetry.shutdown();
```

## Express Usage

```ts
import express from "express";
import {
  createExpressInstrumentationMiddleware,
  startTelemetry
} from "@julianm-lrj/node-instrumentation";

startTelemetry({ serviceName: "express-api" });

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(createExpressInstrumentationMiddleware());
```

## h3 Usage

```ts
import { createApp, createRouter, eventHandler, readBody, toNodeListener } from "h3";
import { instrumentH3Handler, startTelemetry } from "@julianm-lrj/node-instrumentation";

startTelemetry({ serviceName: "h3-api" });

const app = createApp();
const router = createRouter();

router.post(
  "/orders/:id",
  instrumentH3Handler(async (event) => {
    const body = await readBody(event);
    return { ok: true, body };
  })
);

app.use(router);
```

## Environment Variables
- `INSTRUMENTATION_CAPTURE_HEADERS` (`true|false`, default `true`)
- `INSTRUMENTATION_CAPTURE_REQUEST_BODY` (`true|false`, default `true`)
- `INSTRUMENTATION_CAPTURE_RESPONSE_BODY` (`true|false`, default `false`)
- `INSTRUMENTATION_ALLOWED_BODY_TYPES`
- `INSTRUMENTATION_DENIED_HEADERS`
- `INSTRUMENTATION_REDACTION_PATTERNS`
- `INSTRUMENTATION_MAX_URL_BYTES`
- `INSTRUMENTATION_MAX_HEADER_VALUE_BYTES`
- `INSTRUMENTATION_MAX_REQUEST_BODY_BYTES`
- `INSTRUMENTATION_MAX_RESPONSE_BODY_BYTES`
- `INSTRUMENTATION_TRACE_SAMPLING_RATE` (`0.0-1.0`, default `1.0`)
- `INSTRUMENTATION_REQUIRE_OTLP_TLS` (`true|false`, default `true`)
- `INSTRUMENTATION_ALLOW_INSECURE_OTLP` (`true|false`, default `false`)
- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
- `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
- `OTEL_EXPORTER_OTLP_HEADERS`
- `OTEL_EXPORTER_OTLP_TIMEOUT`

## OTLP TLS Flag
- Secure by default: TLS is enforced unless explicitly disabled.
- Runtime flag: start with `--allow-insecure-otlp` to allow `http://` OTLP exporter URLs.
- Programmatic override: `startTelemetry({ requireOtlpTls: false })`.
