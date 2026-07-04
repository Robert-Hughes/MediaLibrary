// Pretty-print MediaLibraryApplyLog.jsonl.  Forensic helper, not part of
// the app build.  Usage:
//
//   tsx tools/inspect-apply-log.ts <path-to-MediaLibraryApplyLog.jsonl>
//   tsx tools/inspect-apply-log.ts <folder-containing-the-log>
//   tsx tools/inspect-apply-log.ts                (defaults to ./MediaLibraryApplyLog.jsonl)
//
// One entry per line, header comment lines starting with `//` skipped.

import * as fs from "node:fs";
import * as path from "node:path";

interface LogEntry {
  timestamp: string;
  relative_path: string;
  tag: string;
  intent: "Set" | "Delete" | "ListAdd" | "ListRemove";
  intended_value: unknown;
  argv: string[];
  after_display: unknown;
  after_raw: unknown;
  outcome: string;
  note: string | null;
}

const OUTCOME_COLOURS: Record<string, string> = {
  Match: "\x1b[32m", // green
  "Delete-Ok": "\x1b[32m", // green
  Coerced: "\x1b[33m", // yellow
  Mismatch: "\x1b[31m", // red
  MissingPostWrite: "\x1b[31m",
  "Delete-Lingering": "\x1b[31m",
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function resolveLogPath(arg: string | undefined): string {
  const candidate = arg ?? "./MediaLibraryApplyLog.jsonl";
  if (fs.existsSync(candidate)) {
    const stat = fs.statSync(candidate);
    if (stat.isDirectory()) {
      return path.join(candidate, "MediaLibraryApplyLog.jsonl");
    }
    return candidate;
  }
  throw new Error(`No such file or folder: ${candidate}`);
}

function valueRepr(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return JSON.stringify(v);
  return JSON.stringify(v);
}

function main(): void {
  const logPath = resolveLogPath(process.argv[2]);
  const raw = fs.readFileSync(logPath, "utf8");
  const lines = raw.split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    if (!line.trim() || line.startsWith("//")) continue;
    let entry: LogEntry;
    try {
      entry = JSON.parse(line) as LogEntry;
    } catch {
      console.warn(`! skipping unparseable line: ${line.slice(0, 80)}`);
      continue;
    }
    count++;
    const colour = OUTCOME_COLOURS[entry.outcome] ?? "";
    console.log(
      `${DIM}${entry.timestamp}${RESET}  ${colour}${entry.outcome.padEnd(18)}${RESET}` +
        `  ${entry.relative_path}  ${entry.tag}  ${DIM}(${entry.intent})${RESET}`,
    );
    console.log(`    intended : ${valueRepr(entry.intended_value)}`);
    console.log(`    display  : ${valueRepr(entry.after_display)}`);
    console.log(`    raw      : ${valueRepr(entry.after_raw)}`);
    if (entry.note) console.log(`    note     : ${entry.note}`);
    if (entry.argv.length > 0)
      console.log(`    argv     : ${entry.argv.join(" ")}`);
    console.log("");
  }
  console.log(`\n${count} entries read from ${logPath}`);
}

main();
