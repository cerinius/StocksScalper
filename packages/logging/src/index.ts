type LogLevel = "debug" | "info" | "warn" | "error";
type LogContext = Record<string, unknown> | undefined;

export interface AppLogger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(bindings: Record<string, unknown>): AppLogger;
}

const secretPattern = /(secret|token|password|webhook|key)/i;

const sanitizeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>((acc, [key, item]) => {
      acc[key] = secretPattern.test(key) ? "[REDACTED]" : sanitizeValue(item);
      return acc;
    }, {});
  }

  return value;
};

const writeLog = (
  level: LogLevel,
  service: string,
  bindings: Record<string, unknown>,
  message: string,
  context?: LogContext,
) => {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    service,
    message,
    ...(sanitizeValue(bindings) as Record<string, unknown>),
    ...(context ? { context: sanitizeValue(context) } : {}),
  };

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
};

export const createLogger = (service: string, bindings: Record<string, unknown> = {}): AppLogger => ({
  debug: (message, context) => writeLog("debug", service, bindings, message, context),
  info: (message, context) => writeLog("info", service, bindings, message, context),
  warn: (message, context) => writeLog("warn", service, bindings, message, context),
  error: (message, context) => writeLog("error", service, bindings, message, context),
  child: (nextBindings) => createLogger(service, { ...bindings, ...nextBindings }),
});
