import { Buffer } from "node:buffer";

import {
  context,
  metrics,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes
} from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { RequestHandler, Response } from "express";

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

function toBuffer(chunk: unknown, encoding?: BufferEncoding): Buffer | undefined {
  if (chunk == null) {
    return undefined;
  }

  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }

  if (typeof chunk === "string") {
    return Buffer.from(chunk, encoding ?? "utf8");
  }

  return Buffer.from(String(chunk), "utf8");
}

function asBufferEncoding(value: unknown): BufferEncoding | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return Buffer.isEncoding(value) ? value : undefined;
}

function hookResponseBodyCapture(response: Response): () => Buffer {
  const chunks: Buffer[] = [];

  const originalWrite = response.write.bind(response);
  const originalEnd = response.end.bind(response);

  const mutableResponse = response as unknown as {
    write: (...args: unknown[]) => boolean;
    end: (...args: unknown[]) => Response;
  };

  mutableResponse.write = (...args: unknown[]): boolean => {
    const [chunk, encoding] = args;
    const buffered = toBuffer(chunk, asBufferEncoding(encoding));
    if (buffered) {
      chunks.push(buffered);
    }

    return originalWrite(...(args as Parameters<typeof originalWrite>));
  };

  mutableResponse.end = (...args: unknown[]): Response => {
    const [chunk, encoding] = args;
    const buffered = toBuffer(chunk, asBufferEncoding(encoding));
    if (buffered) {
      chunks.push(buffered);
    }

    return originalEnd(...(args as Parameters<typeof originalEnd>));
  };

  return () => Buffer.concat(chunks);
}

function bodyCaptureConfig(config: InstrumentationConfig): Pick<
  InstrumentationConfig,
  "allowedBodyTypes" | "redactionPatterns" | "maxRequestBodyBytes" | "captureRequestBody"
> {
  return {
    allowedBodyTypes: config.allowedBodyTypes,
    redactionPatterns: config.redactionPatterns,
    maxRequestBodyBytes: config.maxRequestBodyBytes,
    captureRequestBody: config.captureRequestBody
  };
}

function responseBodyCaptureConfig(config: InstrumentationConfig): Pick<
  InstrumentationConfig,
  "allowedBodyTypes" | "redactionPatterns" | "maxResponseBodyBytes" | "captureResponseBody"
> {
  return {
    allowedBodyTypes: config.allowedBodyTypes,
    redactionPatterns: config.redactionPatterns,
    maxResponseBodyBytes: config.maxResponseBodyBytes,
    captureResponseBody: config.captureResponseBody
  };
}

function logRequestStart(method: string, path: string): void {
  logger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    body: "http.request.start",
    attributes: {
      "http.request.method": method,
      "url.path": path
    }
  });
}

function logRequestEnd(
  method: string,
  path: string,
  statusCode: number,
  durationMs: number,
  error: unknown
): void {
  const isError = statusCode >= 500 || error != null;

  logger.emit({
    severityNumber: isError ? SeverityNumber.ERROR : SeverityNumber.INFO,
    severityText: isError ? "ERROR" : "INFO",
    body: "http.request.end",
    attributes: {
      "http.request.method": method,
      "url.path": path,
      "http.response.status_code": statusCode,
      "http.server.duration_ms": durationMs,
      "error.message": error instanceof Error ? error.message : undefined
    }
  });
}

export function createExpressInstrumentationMiddleware(
  overrides: Partial<InstrumentationConfig> = {}
): RequestHandler {
  const config = resolveConfig(overrides);

  return function expressInstrumentation(req, res, next): void {
    try {
      const rawUrl = req.originalUrl || req.url || "/";
      if (isExcludedPath(rawUrl, config.excludedPaths)) {
        next();
        return;
      }

      const method = req.method.toUpperCase();
      const safePath = sanitizePath(rawUrl, config.maxUrlBytes);
      const safeQuery = sanitizeQueryString(rawUrl, {
        redactionPatterns: config.redactionPatterns,
        maxUrlBytes: config.maxUrlBytes
      });
      const normalizedRoute = normalizeRoutePath(req.path || safePath.value);

      const requestHeaders = config.captureHeaders
        ? sanitizeHeaders(req.headers as Record<string, unknown>, {
            deniedHeaders: config.deniedHeaders,
            redactionPatterns: config.redactionPatterns,
            maxHeaderValueBytes: config.maxHeaderValueBytes
          })
        : {};

      const requestBody = sanitizeBody(
        req.body,
        headerAsString(req.headers["content-type"]),
        bodyCaptureConfig(config)
      );

      const requestContentLength = parseContentLength(req.headers["content-length"]);
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

      const spanContext = trace.setSpan(context.active(), span);
      const startTime = process.hrtime.bigint();

      logRequestStart(method, safePath.value);

      const responseBodyReader = config.captureResponseBody ? hookResponseBodyCapture(res) : undefined;

      let finished = false;
      const complete = (error?: unknown): void => {
        if (finished) {
          return;
        }
        finished = true;

        const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
        const statusCode = res.statusCode || 500;

        const metricAttributes: Attributes = {
          "http.request.method": method,
          "http.route": normalizedRoute,
          "http.response.status_code": statusCode,
          "http.response.status_class": statusClass(statusCode)
        };

        const responseHeaders = config.captureHeaders
          ? sanitizeHeaders(res.getHeaders() as Record<string, unknown>, {
              deniedHeaders: config.deniedHeaders,
              redactionPatterns: config.redactionPatterns,
              maxHeaderValueBytes: config.maxHeaderValueBytes
            })
          : {};

        const responseBuffer = responseBodyReader?.();
        const responseBody = sanitizeResponseBody(
          responseBuffer && responseBuffer.length > 0 ? responseBuffer.toString("utf8") : undefined,
          headerAsString(res.getHeader("content-type")),
          responseBodyCaptureConfig(config)
        );

        const responseContentLength = parseContentLength(res.getHeader("content-length"));
        const responseSize = responseContentLength ?? responseBody.sizeBytes;

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

          if (error instanceof Error) {
            span.recordException(error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error.message
            });
          } else if (statusCode >= 500) {
            span.setStatus({
              code: SpanStatusCode.ERROR
            });
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
          }

          requestCount.add(1, metricAttributes);
          if (statusCode >= 500 || error != null) {
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

          logRequestEnd(method, safePath.value, statusCode, durationMs, error);
          span.end();
        });
      };

      res.once("finish", () => complete());
      res.once("close", () => {
        if (!res.writableEnded) {
          complete(new Error("response closed before completion"));
        }
      });
      res.once("error", (error) => complete(error));

      context.with(spanContext, () => next());
    } catch {
      // Instrumentation must fail open and never block normal request handling.
      next();
    }
  };
}
