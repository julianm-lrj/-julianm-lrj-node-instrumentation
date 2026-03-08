import {
  context,
  metrics,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes
} from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";

import { resolveConfig, type InstrumentationConfig } from "./config.js";
import { headerAsString, isExcludedPath, parseContentLength, statusClass } from "./http-helpers.js";
import {
  normalizeRoutePath,
  sanitizeBody,
  sanitizeHeaders,
  sanitizePath,
  sanitizeQueryString,
  sanitizeResponseBody,
  serializeAsAttribute
} from "./redaction.js";

export interface H3LikeEvent {
  node: {
    req: {
      method?: string;
      url?: string;
      headers: Record<string, unknown>;
    };
    res: {
      statusCode?: number;
      getHeader?: (name: string) => unknown;
      getHeaders?: () => Record<string, unknown>;
    };
  };
  context?: Record<string, unknown>;
}

export type H3LikeHandler<TResult = unknown, TEvent extends H3LikeEvent = H3LikeEvent> = (
  event: TEvent
) => Promise<TResult> | TResult;

const tracer = trace.getTracer("@julianm-lrj/node-instrumentation", "0.1.0");
const meter = metrics.getMeter("@julianm-lrj/node-instrumentation", "0.1.0");
const logger = logs.getLogger("@julianm-lrj/node-instrumentation", "0.1.0");

const requestCount = meter.createCounter("http.server.request.count", {
  description: "Total HTTP server requests"
});
const errorCount = meter.createCounter("http.server.error.count", {
  description: "Total HTTP server requests that ended in error"
});
const durationHistogram = meter.createHistogram("http.server.duration", {
  description: "HTTP server request duration in milliseconds",
  unit: "ms"
});
const payloadSizeHistogram = meter.createHistogram("http.server.payload.size", {
  description: "HTTP payload size in bytes",
  unit: "By"
});

async function readBodyBestEffort(event: H3LikeEvent): Promise<unknown> {
  if (event.context && "body" in event.context) {
    return event.context.body;
  }

  try {
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)"
    ) as (specifier: string) => Promise<unknown>;
    const h3Module = (await dynamicImport("h3")) as {
      readBody?: (target: unknown) => Promise<unknown>;
    };

    if (typeof h3Module.readBody === "function") {
      return await h3Module.readBody(event);
    }
  } catch {
    // No-op by design: instrumentation must fail open.
  }

  return undefined;
}

export function instrumentH3Handler<TResult, TEvent extends H3LikeEvent = H3LikeEvent>(
  handler: H3LikeHandler<TResult, TEvent>,
  overrides: Partial<InstrumentationConfig> = {}
): H3LikeHandler<TResult, TEvent> {
  const config = resolveConfig(overrides);

  return async function h3InstrumentedHandler(event: TEvent): Promise<TResult> {
    const rawUrl = event.node.req.url || "/";
    if (isExcludedPath(rawUrl, config.excludedPaths)) {
      return handler(event);
    }

    const method = (event.node.req.method || "GET").toUpperCase();
    const safePath = sanitizePath(rawUrl, config.maxUrlBytes);
    const safeQuery = sanitizeQueryString(rawUrl, {
      redactionPatterns: config.redactionPatterns,
      maxUrlBytes: config.maxUrlBytes
    });
    const normalizedRoute = normalizeRoutePath(safePath.value);

    const requestHeaders = config.captureHeaders
      ? sanitizeHeaders(event.node.req.headers, {
          deniedHeaders: config.deniedHeaders,
          redactionPatterns: config.redactionPatterns,
          maxHeaderValueBytes: config.maxHeaderValueBytes
        })
      : {};

    const requestBodyRaw = config.captureRequestBody ? await readBodyBestEffort(event) : undefined;
    const requestBody = sanitizeBody(
      requestBodyRaw,
      headerAsString(event.node.req.headers["content-type"]),
      {
        allowedBodyTypes: config.allowedBodyTypes,
        redactionPatterns: config.redactionPatterns,
        maxRequestBodyBytes: config.maxRequestBodyBytes,
        captureRequestBody: config.captureRequestBody
      }
    );

    const requestContentLength = parseContentLength(event.node.req.headers["content-length"]);
    const requestSize = requestContentLength ?? requestBody.sizeBytes;

    const span = tracer.startSpan(`HTTP ${method} ${normalizedRoute}`, {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": method,
        "http.route": normalizedRoute,
        "url.path": safePath.value,
        "url.query": safeQuery.value,
        "service.environment": config.deploymentEnvironment,
        "http.request.body.captured": requestBody.captured,
        "http.request.body.reason": requestBody.reason,
        "http.request.body.content_type": requestBody.contentType,
        "http.request.body.truncated": requestBody.truncated,
        "http.request.body.size": requestBody.sizeBytes,
        "http.request.body": requestBody.value,
        "http.request.headers":
          config.captureHeaders && Object.keys(requestHeaders).length > 0
            ? serializeAsAttribute(requestHeaders, config.maxRequestBodyBytes)
            : undefined
      }
    });

    const startTime = process.hrtime.bigint();
    const spanContext = trace.setSpan(context.active(), span);

    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: "http.request.start",
      attributes: {
        "http.request.method": method,
        "url.path": safePath.value
      }
    });

    let responseValue: TResult | undefined;
    let caughtError: unknown;

    try {
      responseValue = await context.with(spanContext, () => handler(event));
      return responseValue;
    } catch (error) {
      caughtError = error;
      throw error;
    } finally {
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      const statusCode = event.node.res.statusCode ?? (caughtError ? 500 : 200);

      const responseHeadersRaw =
        typeof event.node.res.getHeaders === "function" ? event.node.res.getHeaders() : {};
      const responseHeaders = config.captureHeaders
        ? sanitizeHeaders(responseHeadersRaw, {
            deniedHeaders: config.deniedHeaders,
            redactionPatterns: config.redactionPatterns,
            maxHeaderValueBytes: config.maxHeaderValueBytes
          })
        : {};

      const responseBody = sanitizeResponseBody(
        responseValue,
        typeof event.node.res.getHeader === "function"
          ? headerAsString(event.node.res.getHeader("content-type"))
          : undefined,
        {
          allowedBodyTypes: config.allowedBodyTypes,
          redactionPatterns: config.redactionPatterns,
          maxResponseBodyBytes: config.maxResponseBodyBytes,
          captureResponseBody: config.captureResponseBody
        }
      );

      const responseSize =
        parseContentLength(
          typeof event.node.res.getHeader === "function"
            ? event.node.res.getHeader("content-length")
            : undefined
        ) ?? responseBody.sizeBytes;

      const metricAttributes: Attributes = {
        "http.request.method": method,
        "http.route": normalizedRoute,
        "http.response.status_code": statusCode,
        "http.response.status_class": statusClass(statusCode)
      };

      context.with(spanContext, () => {
        span.setAttributes({
          "http.response.status_code": statusCode,
          "http.server.duration_ms": durationMs,
          "http.response.body.captured": responseBody.captured,
          "http.response.body.reason": responseBody.reason,
          "http.response.body.content_type": responseBody.contentType,
          "http.response.body.truncated": responseBody.truncated,
          "http.response.body.size": responseBody.sizeBytes,
          "http.response.body": responseBody.value,
          "http.response.headers":
            config.captureHeaders && Object.keys(responseHeaders).length > 0
              ? serializeAsAttribute(responseHeaders, config.maxResponseBodyBytes)
              : undefined,
          "http.request.size": requestSize,
          "http.response.size": responseSize
        });

        if (caughtError instanceof Error) {
          span.recordException(caughtError);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: caughtError.message
          });
        } else if (statusCode >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        requestCount.add(1, metricAttributes);
        if (caughtError != null || statusCode >= 500) {
          errorCount.add(1, metricAttributes);
        }
        durationHistogram.record(durationMs, metricAttributes);

        if (requestSize != null) {
          payloadSizeHistogram.record(requestSize, {
            ...metricAttributes,
            "http.payload.direction": "request"
          });
        }

        if (responseSize != null) {
          payloadSizeHistogram.record(responseSize, {
            ...metricAttributes,
            "http.payload.direction": "response"
          });
        }

        logger.emit({
          severityNumber:
            caughtError != null || statusCode >= 500 ? SeverityNumber.ERROR : SeverityNumber.INFO,
          severityText: caughtError != null || statusCode >= 500 ? "ERROR" : "INFO",
          body: "http.request.end",
          attributes: {
            "http.request.method": method,
            "url.path": safePath.value,
            "http.response.status_code": statusCode,
            "http.server.duration_ms": durationMs,
            "error.message": caughtError instanceof Error ? caughtError.message : undefined
          }
        });

        span.end();
      });
    }
  };
}
