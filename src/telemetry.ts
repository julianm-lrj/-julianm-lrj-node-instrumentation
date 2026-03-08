import process from "node:process";

import { metrics } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator
} from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import { resolveConfig, type InstrumentationConfig } from "./config.js";

export interface TelemetryRuntime {
  config: InstrumentationConfig;
  shutdown: () => Promise<void>;
}

function trimRightSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function otlpUrl(
  explicit: string | undefined,
  base: string | undefined,
  fallbackPath: "/v1/traces" | "/v1/metrics" | "/v1/logs"
): string | undefined {
  if (explicit) {
    return explicit;
  }

  if (!base) {
    return undefined;
  }

  return `${trimRightSlash(base)}${fallbackPath}`;
}

function resourceFromConfig(config: InstrumentationConfig): Resource {
  return resourceFromAttributes({
    "service.name": config.serviceName,
    "service.version": config.serviceVersion,
    "deployment.environment": config.deploymentEnvironment
  });
}

function otlpConfig(url: string | undefined, config: InstrumentationConfig): {
  headers: Record<string, string>;
  timeoutMillis: number;
  url?: string;
} {
  const output: {
    headers: Record<string, string>;
    timeoutMillis: number;
    url?: string;
  } = {
    headers: config.otlpHeaders,
    timeoutMillis: config.otlpTimeoutMillis
  };

  if (url) {
    output.url = url;
  }

  return output;
}

function enforceTls(url: string | undefined, config: InstrumentationConfig, signal: string): string | undefined {
  if (!url || !config.requireOtlpTls) {
    return url;
  }

  if (url.startsWith("https://")) {
    return url;
  }

  // Keep application behavior fail-open while blocking insecure telemetry transport by default.
  console.warn(
    `[node-instrumentation] ${signal} OTLP endpoint is not TLS; exporter URL ignored: ${url}`
  );
  return undefined;
}

export function startTelemetry(overrides: Partial<InstrumentationConfig> = {}): TelemetryRuntime {
  const config = resolveConfig(overrides);
  const resource = resourceFromConfig(config);

  const traceExporter = new OTLPTraceExporter(
    otlpConfig(
      enforceTls(
        otlpUrl(config.otlpTracesEndpoint, config.otlpEndpoint, "/v1/traces"),
        config,
        "trace"
      ),
      config
    )
  );

  const metricExporter = new OTLPMetricExporter(
    otlpConfig(
      enforceTls(
        otlpUrl(config.otlpMetricsEndpoint, config.otlpEndpoint, "/v1/metrics"),
        config,
        "metric"
      ),
      config
    )
  );

  const logExporter = new OTLPLogExporter(
    otlpConfig(
      enforceTls(
        otlpUrl(config.otlpLogsEndpoint, config.otlpEndpoint, "/v1/logs"),
        config,
        "log"
      ),
      config
    )
  );

  const tracerProvider = new NodeTracerProvider({
    resource,
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.traceSamplingRate)
    }),
    spanProcessors: [new BatchSpanProcessor(traceExporter)]
  });

  tracerProvider.register({
    contextManager: new AsyncLocalStorageContextManager().enable(),
    propagator: new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()]
    })
  });

  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: config.metricExportIntervalMillis
  });

  const meterProvider = new MeterProvider({
    resource,
    readers: [metricReader]
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor(logExporter)]
  });
  logs.setGlobalLoggerProvider(loggerProvider);

  let signalHandlerAttached = false;
  let shutdownPromise: Promise<void> | undefined;

  const handleSignal = (): void => {
    // Shutdown is best-effort and must not terminate request processing abruptly.
    void shutdown();
  };

  const shutdown = async (): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      await Promise.allSettled([
        tracerProvider.shutdown(),
        meterProvider.shutdown(),
        loggerProvider.shutdown()
      ]);

      if (signalHandlerAttached) {
        process.off("SIGTERM", handleSignal);
        process.off("SIGINT", handleSignal);
        signalHandlerAttached = false;
      }
    })();

    return shutdownPromise;
  };

  if (config.installSignalHandlers) {
    process.on("SIGTERM", handleSignal);
    process.on("SIGINT", handleSignal);
    signalHandlerAttached = true;
  }

  return {
    config,
    shutdown
  };
}
