# @julianm-lrj/node-instrumentation

Production-focused OpenTelemetry instrumentation helpers for Node services.

[![CI](https://github.com/julianm-lrj/-julianm-lrj-node-instrumentation/actions/workflows/ci.yml/badge.svg)](https://github.com/julianm-lrj/-julianm-lrj-node-instrumentation/actions/workflows/ci.yml) 
[![Code Quality](https://github.com/julianm-lrj/-julianm-lrj-node-instrumentation/actions/workflows/code-quality.yml/badge.svg)](https://github.com/julianm-lrj/-julianm-lrj-node-instrumentation/actions/workflows/code-quality.yml)
[![CodeQL Advanced](https://github.com/julianm-lrj/-julianm-lrj-node-instrumentation/actions/workflows/codeql.yml/badge.svg)](https://github.com/julianm-lrj/-julianm-lrj-node-instrumentation/actions/workflows/codeql.yml)
[![Dependabot Updates](https://github.com/julianm-lrj/-julianm-lrj-node-instrumentation/actions/workflows/dependabot/dependabot-updates/badge.svg)](https://github.com/julianm-lrj/-julianm-lrj-node-instrumentation/actions/workflows/dependabot/dependabot-updates)
[![Publish to npm](https://github.com/julianm-lrj/-julianm-lrj-node-instrumentation/actions/workflows/publish.yml/badge.svg)](https://github.com/julianm-lrj/-julianm-lrj-node-instrumentation/actions/workflows/publish.yml)
[![Security Review](https://github.com/julianm-lrj/-julianm-lrj-node-instrumentation/actions/workflows/security-review.yml/badge.svg)](https://github.com/julianm-lrj/-julianm-lrj-node-instrumentation/actions/workflows/security-review.yml)

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

## Module System Support

This package supports both ESM and CommonJS natively — no dynamic import workarounds required.

### ESM (ECMAScript Modules)

```typescript
import { startTelemetry, createExpressInstrumentationMiddleware } from '@julianm-lrj/node-instrumentation';
```

### CommonJS

```javascript
const { startTelemetry, createExpressInstrumentationMiddleware } = require('@julianm-lrj/node-instrumentation');
```

## Runtime Support
- Minimum supported Node.js version: `20.6.0`
- Continuously validated in CI on Node `20.x` and `24.x`

## Quality Gates
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run test:coverage` (full `src/**/*.ts` coverage; fails below `90%` lines/statements, `80%` branches, `95%` functions, and writes `coverage/lcov.info`)

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

## startTelemetry Config Type
`startTelemetry` accepts `overrides?: Partial<InstrumentationConfig>`.

All fields are optional. Resolution order is: explicit overrides -> environment variables -> built-in defaults.

```ts
type StartTelemetryConfig = Partial<{
  serviceName: string;
  serviceVersion: string;
  deploymentEnvironment: string;
  captureHeaders: boolean;
  captureRequestBody: boolean;
  captureResponseBody: boolean;
  allowedBodyTypes: string[];
  deniedHeaders: string[];
  redactionPatterns: RegExp[];
  maxUrlBytes: number;
  maxHeaderValueBytes: number;
  maxRequestBodyBytes: number;
  maxResponseBodyBytes: number;
  traceSamplingRate: number;
  excludedPaths: string[];
  otlpEndpoint: string | undefined;
  otlpTracesEndpoint: string | undefined;
  otlpMetricsEndpoint: string | undefined;
  otlpLogsEndpoint: string | undefined;
  otlpHeaders: Record<string, string>;
  otlpTimeoutMillis: number;
  metricExportIntervalMillis: number;
  requireOtlpTls: boolean;
  installSignalHandlers: boolean;
}>;
```

Practical requirement: set `serviceName` for clear service identity in observability backends.

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
- `OTEL_SERVICE_NAME` (default `node-instrumentation`)
- `OTEL_SERVICE_VERSION` (default `npm_package_version`; then nearest `package.json` `version`; then `0.0.0`)
- `OTEL_DEPLOYMENT_ENVIRONMENT` (default `NODE_ENV`; then `production`)
- `INSTRUMENTATION_CAPTURE_HEADERS` (`true|false`, default `true`)
- `INSTRUMENTATION_CAPTURE_REQUEST_BODY` (`true|false`, default `true`)
- `INSTRUMENTATION_CAPTURE_RESPONSE_BODY` (`true|false`, default `false`)
- `INSTRUMENTATION_ALLOWED_BODY_TYPES` (CSV, default `application/json,application/x-www-form-urlencoded`)
- `INSTRUMENTATION_DENIED_HEADERS` (CSV, default `authorization,proxy-authorization,cookie,set-cookie,x-api-key,x-auth-token,x-access-token,x-session-id,*token*,*secret*,*password*`)
- `INSTRUMENTATION_REDACTION_PATTERNS` (CSV regex/literals, default built-in sensitive key patterns)
- `INSTRUMENTATION_MAX_URL_BYTES` (default `2048`, min `128`)
- `INSTRUMENTATION_MAX_HEADER_VALUE_BYTES` (default `1024`, min `64`)
- `INSTRUMENTATION_MAX_REQUEST_BODY_BYTES` (default `8192`, min `256`)
- `INSTRUMENTATION_MAX_RESPONSE_BODY_BYTES` (default `4096`, min `256`)
- `INSTRUMENTATION_TRACE_SAMPLING_RATE` (`0.0-1.0`, default `1.0`)
- `INSTRUMENTATION_EXCLUDED_PATHS` (CSV, default `/health,/ready,/metrics`)
- `INSTRUMENTATION_REQUIRE_OTLP_TLS` (`true|false`, default `true`)
- `INSTRUMENTATION_ALLOW_INSECURE_OTLP` (`true|false`, default `false`)
- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
- `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
- `OTEL_EXPORTER_OTLP_HEADERS` (CSV `key=value` pairs, default empty)
- `OTEL_EXPORTER_OTLP_TIMEOUT` (milliseconds, default `10000`, min `1000`)
- `INSTRUMENTATION_METRIC_EXPORT_INTERVAL_MS` (milliseconds, default `10000`, min `1000`)
- `INSTRUMENTATION_INSTALL_SIGNAL_HANDLERS` (`true|false`, default `true`)

## OTLP TLS Flag
- Automatic disable: if a trace/metric/log OTLP URL is missing (or rejected by TLS policy), export for that signal is skipped automatically.
- Per-signal behavior: you can configure only `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, or `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`; unconfigured signals remain disabled.
- Secure by default: TLS is enforced unless explicitly disabled.
- Runtime flag: start with `--allow-insecure-otlp` to allow `http://` OTLP exporter URLs.
- Programmatic override: `startTelemetry({ requireOtlpTls: false })`.
