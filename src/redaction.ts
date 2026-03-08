import { URL } from "node:url";

import type { InstrumentationConfig } from "./config.js";

export const REDACTED_VALUE = "[REDACTED]";
export const TRUNCATED_SUFFIX = "...[TRUNCATED]";

export interface SanitizedBodyResult {
  captured: boolean;
  contentType?: string;
  value?: string;
  truncated?: boolean;
  sizeBytes?: number;
  reason?: "disabled" | "empty" | "unsupported-content-type";
}

export function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (maxBytes <= 0) {
    return { value: "", truncated: value.length > 0 };
  }

  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) {
    return { value, truncated: false };
  }

  const suffixBytes = Buffer.byteLength(TRUNCATED_SUFFIX, "utf8");
  const keepBytes = Math.max(0, maxBytes - suffixBytes);
  const truncatedValue = `${buffer.subarray(0, keepBytes).toString("utf8")}${TRUNCATED_SUFFIX}`;
  return { value: truncatedValue, truncated: true };
}

function parseWildcardPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function coerceHeaderValue(input: unknown): string {
  if (Array.isArray(input)) {
    return input.map((item) => String(item)).join(",");
  }

  if (input == null) {
    return "";
  }

  return String(input);
}

function contentTypeBase(contentType: string | undefined): string {
  if (!contentType) {
    return "";
  }

  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function toUrl(urlOrPath: string): URL {
  try {
    return new URL(urlOrPath, "http://localhost");
  } catch {
    return new URL("/", "http://localhost");
  }
}

export function isSensitiveKey(key: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(key));
}

export function isDeniedHeader(headerName: string, deniedHeaders: string[]): boolean {
  const normalized = headerName.toLowerCase();

  for (const denied of deniedHeaders) {
    const deniedNormalized = denied.toLowerCase();

    if (deniedNormalized.includes("*")) {
      const pattern = parseWildcardPattern(deniedNormalized);
      if (pattern.test(normalized)) {
        return true;
      }
      continue;
    }

    if (normalized === deniedNormalized) {
      return true;
    }
  }

  return false;
}

export function sanitizeHeaders(
  headers: Record<string, unknown>,
  config: Pick<InstrumentationConfig, "deniedHeaders" | "redactionPatterns" | "maxHeaderValueBytes">
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (isDeniedHeader(key, config.deniedHeaders)) {
      continue;
    }

    let value = coerceHeaderValue(rawValue);
    if (isSensitiveKey(key, config.redactionPatterns)) {
      value = REDACTED_VALUE;
    }

    const truncated = truncateUtf8(value, config.maxHeaderValueBytes);
    sanitized[key] = truncated.value;
  }

  return sanitized;
}

export function sanitizePath(path: string, maxBytes: number): { value: string; truncated: boolean } {
  const parsed = toUrl(path);
  return truncateUtf8(parsed.pathname || "/", maxBytes);
}

export function sanitizeQueryString(
  pathOrUrl: string,
  config: Pick<InstrumentationConfig, "redactionPatterns" | "maxUrlBytes">
): { value: string; truncated: boolean } {
  const parsed = toUrl(pathOrUrl);
  const sanitized = new URLSearchParams();

  for (const [key, value] of parsed.searchParams.entries()) {
    const safeValue = isSensitiveKey(key, config.redactionPatterns) ? REDACTED_VALUE : value;
    sanitized.append(key, safeValue);
  }

  return truncateUtf8(sanitized.toString(), config.maxUrlBytes);
}

export function normalizeRoutePath(path: string): string {
  const parts = path.split("/");
  const normalized = parts.map((part) => {
    if (part.length === 0) {
      return part;
    }

    if (/^\d+$/.test(part)) {
      return ":id";
    }

    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(part)) {
      return ":id";
    }

    if (/^[0-9a-f]{16,}$/i.test(part)) {
      return ":id";
    }

    return part;
  });

  return normalized.join("/") || "/";
}

function redactUnknown(
  value: unknown,
  config: Pick<InstrumentationConfig, "redactionPatterns">,
  seen: WeakSet<object>
): unknown {
  if (value == null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry, config, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[CIRCULAR]";
    }
    seen.add(value);

    const output: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      output[key] = isSensitiveKey(key, config.redactionPatterns)
        ? REDACTED_VALUE
        : redactUnknown(nestedValue, config, seen);
    }
    return output;
  }

  return value;
}

function redactFormEncoded(value: string, patterns: RegExp[]): string {
  const params = new URLSearchParams(value);
  const redacted = new URLSearchParams();

  for (const [key, entry] of params.entries()) {
    redacted.append(key, isSensitiveKey(key, patterns) ? REDACTED_VALUE : entry);
  }

  return redacted.toString();
}

function redactJsonLikeText(value: string, patterns: RegExp[]): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    const redacted = redactUnknown(parsed, { redactionPatterns: patterns }, new WeakSet<object>());
    return JSON.stringify(redacted);
  } catch {
    return value;
  }
}

function isAllowedBodyType(contentType: string, allowedBodyTypes: string[]): boolean {
  if (contentType.length === 0) {
    return false;
  }

  return allowedBodyTypes.some((allowed) => {
    if (allowed.endsWith("/*")) {
      return contentType.startsWith(allowed.slice(0, -1));
    }
    return allowed === contentType;
  });
}

function stringifyBody(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }

  if (Buffer.isBuffer(body)) {
    return body.toString("utf8");
  }

  if (body == null) {
    return "";
  }

  if (typeof body === "object") {
    return JSON.stringify(body);
  }

  return String(body);
}

export function sanitizeBody(
  body: unknown,
  contentTypeHeader: string | undefined,
  config: Pick<
    InstrumentationConfig,
    "captureRequestBody" | "allowedBodyTypes" | "redactionPatterns" | "maxRequestBodyBytes"
  >
): SanitizedBodyResult {
  if (!config.captureRequestBody) {
    return { captured: false, reason: "disabled" };
  }

  if (body == null) {
    return { captured: false, reason: "empty", contentType: contentTypeBase(contentTypeHeader) };
  }

  const normalizedType = contentTypeBase(contentTypeHeader);
  if (!isAllowedBodyType(normalizedType, config.allowedBodyTypes)) {
    return { captured: false, reason: "unsupported-content-type", contentType: normalizedType };
  }

  const serialized = stringifyBody(body);
  const sizeBytes = Buffer.byteLength(serialized, "utf8");

  let redacted: string;
  if (normalizedType === "application/x-www-form-urlencoded") {
    redacted = redactFormEncoded(serialized, config.redactionPatterns);
  } else {
    redacted = redactJsonLikeText(serialized, config.redactionPatterns);
  }

  const truncated = truncateUtf8(redacted, config.maxRequestBodyBytes);
  return {
    captured: true,
    contentType: normalizedType,
    value: truncated.value,
    truncated: truncated.truncated,
    sizeBytes
  };
}

export function sanitizeResponseBody(
  body: unknown,
  contentTypeHeader: string | undefined,
  config: Pick<
    InstrumentationConfig,
    "captureResponseBody" | "allowedBodyTypes" | "redactionPatterns" | "maxResponseBodyBytes"
  >
): SanitizedBodyResult {
  if (!config.captureResponseBody) {
    return { captured: false, reason: "disabled" };
  }

  if (body == null) {
    return { captured: false, reason: "empty", contentType: contentTypeBase(contentTypeHeader) };
  }

  const normalizedType = contentTypeBase(contentTypeHeader);
  if (!isAllowedBodyType(normalizedType, config.allowedBodyTypes)) {
    return { captured: false, reason: "unsupported-content-type", contentType: normalizedType };
  }

  const serialized = stringifyBody(body);
  const sizeBytes = Buffer.byteLength(serialized, "utf8");

  let redacted: string;
  if (normalizedType === "application/x-www-form-urlencoded") {
    redacted = redactFormEncoded(serialized, config.redactionPatterns);
  } else {
    redacted = redactJsonLikeText(serialized, config.redactionPatterns);
  }

  const truncated = truncateUtf8(redacted, config.maxResponseBodyBytes);
  return {
    captured: true,
    contentType: normalizedType,
    value: truncated.value,
    truncated: truncated.truncated,
    sizeBytes
  };
}

export function serializeAsAttribute(value: unknown, maxBytes: number): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return truncateUtf8(serialized, maxBytes).value;
}
