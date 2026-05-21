import { invoke } from "@tauri-apps/api/core";

// Intercept console methods and forward to Rust for stdout + file
// logging. `console.debug` is deliberately NOT intercepted — hot-path
// callsites (per-batch flush logs, per-event receipt counters) use it
// so they stay visible in the browser devtools (when verbose is on)
// without spamming the on-disk Rust log every batch.
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

function stringify(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
  if (typeof v === "object") {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

// printf-style substitution matching the browser console contract
// (handles %s/%d/%i/%f/%o/%O/%c/%%). Required so React's
// formatted messages like "Warning: %s\n%s" render correctly when
// forwarded to the backend log.
function formatArgs(args: unknown[]): string {
  if (args.length === 0) return "";
  const first = args[0];
  if (typeof first !== "string") return args.map(stringify).join(" ");
  let i = 1;
  const out = first.replace(/%[sdifoOc%]/g, (m) => {
    if (m === "%%") return "%";
    if (m === "%c") { i++; return ""; }
    if (i >= args.length) return m;
    const v = args[i++];
    if (m === "%d" || m === "%i") return String(parseInt(String(v), 10));
    if (m === "%f") return String(parseFloat(String(v)));
    return stringify(v);
  });
  const rest = args.slice(i).map(stringify).join(" ");
  return rest ? `${out} ${rest}` : out;
}

export function setupConsoleLogging() {
  const make = (level: "log" | "info" | "warn" | "error") => (...args: unknown[]) => {
    originalConsole[level](...(args as any[]));
    invoke("log_to_console", { level, message: formatArgs(args) }).catch(() => {});
  };

  console.log = make("log");
  console.info = make("info");
  console.warn = make("warn");
  console.error = make("error");
}
