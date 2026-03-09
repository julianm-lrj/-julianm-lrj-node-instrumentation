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

  const traceUrl = enforceTls(
    otlpUrl(config.otlpTracesEndpoint, config.otlpEndpoint, "/v1/traces"),
    config,
    "trace"
  );
  const metricUrl = enforceTls(
    otlpUrl(config.otlpMetricsEndpoint, config.otlpEndpoint, "/v1/metrics"),
    config,
    "metric"
  );
  const logUrl = enforceTls(
    otlpUrl(config.otlpLogsEndpoint, config.otlpEndpoint, "/v1/logs"),
    config,
    "log"
  );

  const disabledSignals = [
    traceUrl == null ? "trace" : undefined,
    metricUrl == null ? "metric" : undefined,
    logUrl == null ? "log" : undefined
  ].filter((signal): signal is string => signal != null);

  if (disabledSignals.length === 3) {
    console.info(
      `[node-instrumentation] OTLP export disabled for signals without a valid endpoint: ${disabledSignals.join(", ")}`
    );
  }

  const spanProcessors: BatchSpanProcessor[] = [];
  if (traceUrl) {
    const traceExporter = new OTLPTraceExporter(otlpConfig(traceUrl, config));
    spanProcessors.push(new BatchSpanProcessor(traceExporter));
  }

  const tracerProvider = new NodeTracerProvider({
    resource,
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.traceSamplingRate)
    }),
    spanProcessors
  });

  tracerProvider.register({
    contextManager: new AsyncLocalStorageContextManager().enable(),
    propagator: new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()]
    })
  });

  const metricReaders: PeriodicExportingMetricReader[] = [];
  if (metricUrl) {
    const metricExporter = new OTLPMetricExporter(otlpConfig(metricUrl, config));
    metricReaders.push(
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: config.metricExportIntervalMillis
      })
    );
  }

  const meterProvider = new MeterProvider({
    resource,
    readers: metricReaders
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const logProcessors: BatchLogRecordProcessor[] = [];
  if (logUrl) {
    const logExporter = new OTLPLogExporter(otlpConfig(logUrl, config));
    logProcessors.push(new BatchLogRecordProcessor(logExporter));
  }

  const loggerProvider = new LoggerProvider({
    resource,
    processors: logProcessors
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
