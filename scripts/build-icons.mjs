#!/usr/bin/env node
// Regenerate src-tauri/icons/* from public/logo-color.svg.
// Source of truth: public/logo.svg (mono) + public/logo-color.svg (color).
// All rasters here are derived; do not hand-edit.
//
// Requires `sharp` (one-off: `npm i -D sharp`) and `@tauri-apps/cli` (already a devDep).
// Usage: `node scripts/build-icons.mjs`

import { execSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(root, "public/logo-color.svg");
const MASTER = resolve(root, "src-tauri/icons/app-icon.png");

let sharp;
try {
  sharp = (await import("sharp")).default;
} catch {
  console.error("Missing dependency 'sharp'. Run: npm i -D sharp");
  process.exit(1);
}

mkdirSync(dirname(MASTER), { recursive: true });
const svg = readFileSync(SRC);
await sharp(svg, { density: 384 }).resize(1024, 1024).png().toFile(MASTER);
console.log(`wrote ${MASTER} (1024x1024)`);

console.log("running `tauri icon` to regenerate platform raster set...");
execSync(`npx tauri icon "${MASTER}"`, { stdio: "inherit", cwd: root });
console.log("done. review git diff under src-tauri/icons/ and commit.");
