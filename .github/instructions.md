# Production Instrumentation Instructions (Node)

## Goal
Build an npm package that instruments Node services for production use with high-fidelity OpenTelemetry data while enforcing strong redaction and bounded payload capture.

## Runtime and Framework Requirements
- Node.js version: `>=24.14.0`.
- Use OpenTelemetry for all three pillars: traces, metrics, and logs.
- First-class server support: Express and h3.
- The package must be safe by default in production and configurable via environment variables.

## Telemetry Coverage (Required)

### Traces
- Create inbound HTTP spans for every request.
- Default production trace sampling: `100%`.
- add env to allow flexible controll over sampling percentage
- Include at minimum:
	- HTTP method
	- Normalized route or template (for low-cardinality analysis)
	- Raw URL path (truncated)
	- Sanitized query string
	- Status code
	- Request and response size (when available)
	- Duration and error status
- Link application logs to spans with `trace_id` and `span_id`.

### Metrics
- Emit request count, error count, and duration histogram.
- Emit payload size histograms (request and response, when available).
- Use normalized route labels for metrics to avoid cardinality blowups.

### Logs
- Emit structured logs with trace correlation.
- Capture request context at start and completion.
- Capture exception and error logs with sanitized details.

## Maximum Data Policy With Guardrails (Required)

### URL and Query Capture
- Capture URL path for all requests.
- Capture query parameters after sanitization.
- Truncate URL and query fields to configured limits.

### Header Capture
- Capture all request and response headers except denied headers.
- Denied headers are never emitted, even in debug modes:
	- `authorization`
	- `proxy-authorization`
	- `cookie`
	- `set-cookie`
	- `x-api-key`
	- `x-auth-token`
	- `x-access-token`
	- `x-session-id`
	- any header matching `*token*`, `*secret*`, or `*password*`
- Header names are case-insensitive.
- Truncate long header values to configured limits.

### Request Body Capture
- Capture request body by default only for:
	- `application/json`
	- `application/x-www-form-urlencoded`
- Do not capture raw body for:
	- `multipart/form-data`
	- `application/octet-stream`
	- `image/*`, `audio/*`, `video/*`
	- other binary or compressed payloads
- For unsupported content types, record metadata only (content type and size).

### Response Body Capture
- Disabled by default in production.
- If enabled, apply the same content-type filters, masking rules, and truncation limits as request bodies.

## Sensitive Data Handling (Required)

### Masking Strategy
- Mask sensitive values, do not drop keys by default.
- Apply masking to headers, query params, JSON bodies, and form fields.
- Redact keys and patterns including:
	- `auth`, `authorization`
	- `token`, `access_token`, `refresh_token`
	- `secret`, `client_secret`
	- `password`, `passphrase`
	- `cookie`, `session`
	- common PII fields: `email`, `phone`, `ssn`, `credit_card`
- Redaction must be recursive for nested JSON objects and arrays.

### Non-Negotiable Rule
- Never emit raw auth credentials, raw cookies, or raw session secrets.

## Payload Limits and Truncation (Required)
- Enforce configurable limits for:
	- max URL and query length
	- max header value length
	- max captured body bytes
- Defaults should prioritize observability with safe bounds:
	- URL and query max: `2048` bytes
	- header value max: `1024` bytes
	- request body capture max: `8192` bytes
	- response body capture max: `4096` bytes (when enabled)
- Mark truncated fields explicitly in emitted telemetry.

## Operational Requirements (Required)
- Export telemetry through OTLP with TLS.
- Use batching, retries, queue limits, and exporter timeouts.
- Instrumentation must fail open:
	- application traffic must continue if telemetry backend is unavailable.
- On shutdown (`SIGTERM`, `SIGINT`), flush and close telemetry providers.
- Exclude instrumentation of exporter endpoints to avoid telemetry loops.

## Configuration Contract (Required)
Expose environment-driven controls at minimum:
- `INSTRUMENTATION_CAPTURE_HEADERS` (`true|false`, default `true`)
- `INSTRUMENTATION_CAPTURE_REQUEST_BODY` (`true|false`, default `true`)
- `INSTRUMENTATION_CAPTURE_RESPONSE_BODY` (`true|false`, default `false`)
- `INSTRUMENTATION_ALLOWED_BODY_TYPES` (default JSON and form-urlencoded)
- `INSTRUMENTATION_DENIED_HEADERS` (default denylist above)
- `INSTRUMENTATION_REDACTION_PATTERNS` (extend default key and pattern list)
- `INSTRUMENTATION_MAX_URL_BYTES`
- `INSTRUMENTATION_MAX_HEADER_VALUE_BYTES`
- `INSTRUMENTATION_MAX_REQUEST_BODY_BYTES`
- `INSTRUMENTATION_MAX_RESPONSE_BODY_BYTES`
- `INSTRUMENTATION_TRACE_SAMPLING_RATE` (default `1.0` in prod profile)

## Production Acceptance Checklist
- [ ] Node minimum version is `>=24.14.0`.
- [ ] Traces, metrics, and logs are all enabled and correlated.
- [ ] Express and h3 are supported.
- [ ] URL path and sanitized query capture are enabled.
- [ ] Header policy is capture-all-except-denylist.
- [ ] Request body capture is limited to JSON and form-urlencoded.
- [ ] Sensitive data masking is enforced across headers, query, and body.
- [ ] Payload truncation limits are enforced and documented.
- [ ] OTLP export reliability and graceful shutdown flush are implemented.