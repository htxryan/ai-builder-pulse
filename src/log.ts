type Level = "info" | "warn" | "error" | "debug";

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(data ?? {}),
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(`::error::${msg}`);
    console.error(line);
  } else if (level === "warn") {
    console.warn(`::warning::${msg}`);
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const log = {
  info: (msg: string, data?: Record<string, unknown>) => emit("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit("error", msg, data),
  debug: (msg: string, data?: Record<string, unknown>) => {
    if (process.env.DEBUG === "1") emit("debug", msg, data);
  },
};
