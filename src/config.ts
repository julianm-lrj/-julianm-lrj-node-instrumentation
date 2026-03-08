import { readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import process from "node:process";

export const DEFAULT_ALLOWED_BODY_TYPES = [
  "application/json",
  "application/x-www-form-urlencoded"
];

export const DEFAULT_DENIED_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-session-id",
  "*token*",
  "*secret*",
  "*password*"
];

export const DEFAULT_REDACTION_PATTERNS = [
  /(^|[_-])(auth|authorization)($|[_-])/i,
  /token/i,
  /secret/i,
  /password|passphrase/i,
  /cookie|session/i,
  /(^|[_-])(email|phone|ssn|credit_card)($|[_-])/i
];

export interface InstrumentationConfig {
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
}

const ALLOW_INSECURE_OTLP_FLAG = "--allow-insecure-otlp";

function resolveNearestPackageVersion(startDir: string): string | undefined {
  let currentDir = startDir;
  const filesystemRoot = parse(startDir).root;

  while (true) {
    const packageJsonPath = join(currentDir, "package.json");

    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
        version?: unknown;
      };

      if (typeof parsed.version === "string" && parsed.version.trim() !== "") {
        return parsed.version.trim();
      }
    } catch {
      // Keep walking up; missing/unreadable/invalid package.json should not break startup.
    }

    if (currentDir === filesystemRoot) {
      return undefined;
    }

    currentDir = dirname(currentDir);
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseNumber(
  value: string | undefined,
  fallback: number,
  min?: number,
  max?: number
): number {
  if (value == null || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  if (min == null && max == null) {
    return parsed;
  }

  return clamp(parsed, min ?? Number.NEGATIVE_INFINITY, max ?? Number.POSITIVE_INFINITY);
}

function parseCsv(value: string | undefined, fallback: string[]): string[] {
  if (value == null || value.trim() === "") {
    return fallback;
  }

  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return parsed.length > 0 ? parsed : fallback;
}

function normalizeStringList(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0))];
}

function parseRegexList(value: string | undefined): RegExp[] {
  if (value == null || value.trim() === "") {
    return [];
  }

  const expressions: RegExp[] = [];
  for (const token of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    // Supports /pattern/flags format; otherwise treats token as a case-insensitive literal.
    if (token.startsWith("/") && token.lastIndexOf("/") > 0) {
      const end = token.lastIndexOf("/");
      const pattern = token.slice(1, end);
      const flags = token.slice(end + 1).replace(/g/g, "");
      expressions.push(new RegExp(pattern, flags));
      continue;
    }

    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expressions.push(new RegExp(escaped, "i"));
  }

  return expressions;
}

function parseOtlpHeaders(value: string | undefined): Record<string, string> {
  if (value == null || value.trim() === "") {
    return {};
  }

  const output: Record<string, string> = {};
  for (const pair of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = pair.slice(0, separatorIndex).trim();
    const tokenValue = pair.slice(separatorIndex + 1).trim();
    if (key.length > 0 && tokenValue.length > 0) {
      output[key] = tokenValue;
    }
  }

  return output;
}

export function resolveConfig(
  overrides: Partial<InstrumentationConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv
): InstrumentationConfig {
  const packageVersion = resolveNearestPackageVersion(process.cwd());

  const allowedBodyTypes = normalizeStringList(
    overrides.allowedBodyTypes ?? parseCsv(env.INSTRUMENTATION_ALLOWED_BODY_TYPES, DEFAULT_ALLOWED_BODY_TYPES)
  );

  const deniedHeaders = normalizeStringList(
    overrides.deniedHeaders ?? parseCsv(env.INSTRUMENTATION_DENIED_HEADERS, DEFAULT_DENIED_HEADERS)
  );

  const envRedactionPatterns = parseRegexList(env.INSTRUMENTATION_REDACTION_PATTERNS);
  const redactionPatterns = overrides.redactionPatterns ?? [...DEFAULT_REDACTION_PATTERNS, ...envRedactionPatterns];

  const traceSamplingRate = clamp(
    overrides.traceSamplingRate ?? parseNumber(env.INSTRUMENTATION_TRACE_SAMPLING_RATE, 1, 0, 1),
    0,
    1
  );

  const requireOtlpTlsFromEnvOrFlags = (() => {
    if (env.INSTRUMENTATION_REQUIRE_OTLP_TLS != null) {
      return parseBoolean(env.INSTRUMENTATION_REQUIRE_OTLP_TLS, true);
    }

    if (env.INSTRUMENTATION_ALLOW_INSECURE_OTLP != null) {
      return !parseBoolean(env.INSTRUMENTATION_ALLOW_INSECURE_OTLP, false);
    }

    return !argv.includes(ALLOW_INSECURE_OTLP_FLAG);
  })();

  return {
    serviceName: overrides.serviceName ?? env.OTEL_SERVICE_NAME ?? "node-instrumentation",
    serviceVersion:
      overrides.serviceVersion ??
      env.OTEL_SERVICE_VERSION ??
      env.npm_package_version ??
      packageVersion ??
      "0.0.0",
    deploymentEnvironment: overrides.deploymentEnvironment ?? env.OTEL_DEPLOYMENT_ENVIRONMENT ?? env.NODE_ENV ?? "production",
    captureHeaders: overrides.captureHeaders ?? parseBoolean(env.INSTRUMENTATION_CAPTURE_HEADERS, true),
    captureRequestBody:
      overrides.captureRequestBody ?? parseBoolean(env.INSTRUMENTATION_CAPTURE_REQUEST_BODY, true),
    captureResponseBody:
      overrides.captureResponseBody ?? parseBoolean(env.INSTRUMENTATION_CAPTURE_RESPONSE_BODY, false),
    allowedBodyTypes,
    deniedHeaders,
    redactionPatterns,
    maxUrlBytes: overrides.maxUrlBytes ?? parseNumber(env.INSTRUMENTATION_MAX_URL_BYTES, 2048, 128),
    maxHeaderValueBytes:
      overrides.maxHeaderValueBytes ?? parseNumber(env.INSTRUMENTATION_MAX_HEADER_VALUE_BYTES, 1024, 64),
    maxRequestBodyBytes:
      overrides.maxRequestBodyBytes ?? parseNumber(env.INSTRUMENTATION_MAX_REQUEST_BODY_BYTES, 8192, 256),
    maxResponseBodyBytes:
      overrides.maxResponseBodyBytes ?? parseNumber(env.INSTRUMENTATION_MAX_RESPONSE_BODY_BYTES, 4096, 256),
    traceSamplingRate,
    excludedPaths:
      overrides.excludedPaths ??
      parseCsv(env.INSTRUMENTATION_EXCLUDED_PATHS, ["/health", "/ready", "/metrics"]),
    otlpEndpoint: overrides.otlpEndpoint ?? env.OTEL_EXPORTER_OTLP_ENDPOINT,
    otlpTracesEndpoint: overrides.otlpTracesEndpoint ?? env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    otlpMetricsEndpoint: overrides.otlpMetricsEndpoint ?? env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    otlpLogsEndpoint: overrides.otlpLogsEndpoint ?? env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    otlpHeaders: overrides.otlpHeaders ?? parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    otlpTimeoutMillis:
      overrides.otlpTimeoutMillis ?? parseNumber(env.OTEL_EXPORTER_OTLP_TIMEOUT, 10000, 1000),
    metricExportIntervalMillis:
      overrides.metricExportIntervalMillis ??
      parseNumber(env.INSTRUMENTATION_METRIC_EXPORT_INTERVAL_MS, 10000, 1000),
    requireOtlpTls: overrides.requireOtlpTls ?? requireOtlpTlsFromEnvOrFlags,
    installSignalHandlers:
      overrides.installSignalHandlers ?? parseBoolean(env.INSTRUMENTATION_INSTALL_SIGNAL_HANDLERS, true)
  };
}
