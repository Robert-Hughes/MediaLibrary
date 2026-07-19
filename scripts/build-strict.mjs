import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, createLogger } from "vite";

export function createStrictLogger(baseLogger = createLogger()) {
  const warnings = [];
  const originalWarn = baseLogger.warn.bind(baseLogger);
  const originalWarnOnce = baseLogger.warnOnce.bind(baseLogger);

  baseLogger.warn = (message, options) => {
    warnings.push(String(message));
    originalWarn(message, options);
  };
  baseLogger.warnOnce = (message, options) => {
    warnings.push(String(message));
    originalWarnOnce(message, options);
  };

  return { logger: baseLogger, warnings };
}

export function assertNoBuildWarnings(warnings) {
  if (warnings.length === 0) return;
  const rendered = warnings.map((warning) => `- ${warning}`).join("\n");
  throw new Error(
    `Vite build emitted ${warnings.length} warning(s):\n${rendered}`,
  );
}

export async function runStrictBuild() {
  const { logger, warnings } = createStrictLogger();
  await build({ customLogger: logger });
  assertNoBuildWarnings(warnings);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  runStrictBuild().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
