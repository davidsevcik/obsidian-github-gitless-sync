/**
 * Copies the README screenshots taken by the last E2E runs to assets/, the
 * newest of each. Scenarios take them with AppWindow.readmeScreenshot.
 *
 *   npm run e2e -- @gui && npm run e2e:readme-screenshots
 */
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { README_PREFIX } from "./lib/ui";

const SCREENSHOTS_DIR = path.join(__dirname, "screenshots");
const ASSETS_DIR = path.join(__dirname, "..", "assets");

// Runs are named by their start time, so they sort from the oldest
const runs = existsSync(SCREENSHOTS_DIR) ? readdirSync(SCREENSHOTS_DIR).sort() : [];
const newest = new Map<string, string>();
for (const run of runs) {
  for (const scenario of readdirSync(path.join(SCREENSHOTS_DIR, run))) {
    const dir = path.join(SCREENSHOTS_DIR, run, scenario);
    for (const file of readdirSync(dir)) {
      // <vault>-readme-<asset>
      const at = file.indexOf(`-${README_PREFIX}`);
      if (at !== -1) {
        newest.set(file.slice(at + README_PREFIX.length + 1), path.join(dir, file));
      }
    }
  }
}
if (newest.size === 0) {
  console.error("No README screenshots, run npm run e2e -- @gui first");
  process.exitCode = 1;
}
for (const [asset, source] of newest) {
  copyFileSync(source, path.join(ASSETS_DIR, asset));
  console.log(`assets/${asset} ← ${path.relative(SCREENSHOTS_DIR, source)}`);
}
