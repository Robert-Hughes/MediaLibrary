import { invoke } from "@tauri-apps/api/core";

// Intercept console methods and forward to Rust for stdout logging
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

export function setupConsoleLogging() {
  console.log = (...args: any[]) => {
    originalConsole.log(...args);
    invoke("log_to_console", { level: "log", message: args.map(String).join(" ") }).catch(() => {});
  };

  console.info = (...args: any[]) => {
    originalConsole.info(...args);
    invoke("log_to_console", { level: "info", message: args.map(String).join(" ") }).catch(() => {});
  };

  console.warn = (...args: any[]) => {
    originalConsole.warn(...args);
    invoke("log_to_console", { level: "warn", message: args.map(String).join(" ") }).catch(() => {});
  };

  console.error = (...args: any[]) => {
    originalConsole.error(...args);
    invoke("log_to_console", { level: "error", message: args.map(String).join(" ") }).catch(() => {});
  };
}
