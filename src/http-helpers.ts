import { URL } from "node:url";

export function toPathname(pathOrUrl: string): string {
  try {
    return new URL(pathOrUrl, "http://localhost").pathname || "/";
  } catch {
    return "/";
  }
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function isExcludedPath(pathOrUrl: string, excludedPaths: string[]): boolean {
  if (excludedPaths.length === 0) {
    return false;
  }

  const path = toPathname(pathOrUrl);
  for (const pattern of excludedPaths) {
    if (pattern.includes("*")) {
      if (wildcardToRegExp(pattern).test(path)) {
        return true;
      }
      continue;
    }

    if (path === pattern || path.startsWith(`${pattern}/`)) {
      return true;
    }
  }

  return false;
}

export function headerAsString(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).join(",");
  }

  return String(value);
}

export function parseContentLength(value: unknown): number | undefined {
  const raw = headerAsString(value);
  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

export function statusClass(statusCode: number): string {
  if (statusCode >= 500) {
    return "5xx";
  }
  if (statusCode >= 400) {
    return "4xx";
  }
  if (statusCode >= 300) {
    return "3xx";
  }
  if (statusCode >= 200) {
    return "2xx";
  }
  return "1xx";
}
