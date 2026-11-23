/**
 * Runs the E2E scenarios against the real plugin, running in Obsidian on the
 * VM, and a real GitHub repository. See e2e/README.md.
 *
 *   npm run e2e -- [filter...] [--list] [--keep] [--no-build] [--bail] [--clean]
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { config, githubToken } from "./lib/config";
import { Remote } from "./lib/github";
import { Device, ObsidianApp, provision } from "./lib/obsidian";
import { Context, DEFAULT_SEED, Scenario } from "./lib/scenario";
import { installVmfs } from "./lib/vm";

const ROOT = path.join(__dirname, "..");

interface Options {
  filters: string[];
  list: boolean;
  keep: boolean;
  build: boolean;
  bail: boolean;
  clean: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    filters: [],
    list: false,
    keep: false,
    build: true,
    bail: false,
    clean: false,
  };
  for (const arg of argv) {
    if (arg === "--list") options.list = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--no-build") options.build = false;
    else if (arg === "--bail") options.bail = true;
    else if (arg === "--clean") options.clean = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else options.filters.push(arg);
  }
  return options;
}

interface Entry {
  id: string; // file/name, e.g. offline/created while Obsidian is closed
  scenario: Scenario;
}

function loadScenarios(): Entry[] {
  const dir = path.join(__dirname, "scenarios");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .flatMap((file) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const loaded = require(path.join(dir, file)).default as
        | Scenario
        | Scenario[];
      const group = file.replace(/\.ts$/, "");
      return (Array.isArray(loaded) ? loaded : [loaded]).map((scenario) => ({
        id: `${group}/${scenario.name}`,
        scenario,
      }));
    });
}

/**
 * A scenario is selected if it matches any filter: @tag matches a tag,
 * anything else a part of its id.
 */
function matches(entry: Entry, filters: string[]): boolean {
  return (
    filters.length === 0 ||
    filters.some((filter) =>
      filter.startsWith("@")
        ? (entry.scenario.tags ?? []).includes(filter.slice(1))
        : entry.id.toLowerCase().includes(filter.toLowerCase()),
    )
  );
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

const color = (code: number) => (text: string) =>
  process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
const red = color(31);
const green = color(32);
const yellow = color(33);
const dim = color(2);

type Outcome = "passed" | "failed" | "known bug" | "known bug passed";

async function runScenario(
  entry: Entry,
  index: number,
  runId: string,
  app: ObsidianApp,
  devices: Map<string, Device>,
  options: Options,
): Promise<Outcome> {
  const { scenario } = entry;
  const scenarioDevices = (scenario.devices ?? ["a"]).map(
    (name) => devices.get(name) as Device,
  );
  const branch = `${config.branchPrefix}${runId}-${index}-${slug(scenario.name)}`;
  console.log(`\n▶ ${entry.id} ${dim(`(${branch})`)}`);
  const started = Date.now();

  let remote: Remote | null = null;
  let currentStep = "setup";
  const step = async <T>(title: string, fn: () => Promise<T>): Promise<T> => {
    currentStep = title;
    console.log(dim(`    · ${title}`));
    return fn();
  };

  try {
    if (!app.running) {
      // A previous scenario failed while Obsidian was closed
      await app.launch();
    }
    remote = await Remote.create(branch, scenario.seed ?? DEFAULT_SEED);
    for (const device of scenarioDevices) {
      await device.reset(branch, {
        ...scenario.settings,
        ...scenario.deviceSettings?.[device.name],
      });
    }
    if (scenario.firstSync ?? true) {
      for (const device of scenarioDevices) {
        await step(`first sync of ${device.label}`, () => device.sync());
      }
    }
    const ctx: Context = {
      remote,
      obsidian: app,
      devices: scenarioDevices,
      get a() {
        return deviceOf("a");
      },
      get b() {
        return deviceOf("b");
      },
      step,
    };
    function deviceOf(name: string): Device {
      const device = scenarioDevices.find((d) => d.name === name);
      if (!device) {
        throw new Error(`Device ${name} is not in the devices of the scenario`);
      }
      return device;
    }
    await scenario.run(ctx);
  } catch (err) {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (scenario.knownBug) {
      console.log(yellow(`  ✗ known bug, ${scenario.knownBug} ${dim(`${seconds}s`)}`));
      console.log(dim(`    ${err instanceof Error ? err.message : err}`.replace(/\n/g, "\n    ")));
      await cleanUp(remote, options);
      return "known bug";
    }
    console.log(red(`  ✗ failed at "${currentStep}" ${dim(`${seconds}s`)}`));
    console.log(
      red(`    ${err instanceof Error ? err.message : err}`.replace(/\n/g, "\n    ")),
    );
    await printDiagnostics(scenarioDevices, remote, app);
    return "failed";
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  await cleanUp(remote, options);
  if (scenario.knownBug) {
    console.log(
      yellow(`  ✓ passed although marked as known bug, remove knownBug? ${dim(`${seconds}s`)}`),
    );
    return "known bug passed";
  }
  console.log(green(`  ✓ passed ${dim(`${seconds}s`)}`));
  return "passed";
}

async function cleanUp(remote: Remote | null, options: Options) {
  if (remote && !options.keep) {
    await remote.delete().catch(() => {});
  }
}

async function printDiagnostics(
  devices: Device[],
  remote: Remote | null,
  app: ObsidianApp,
) {
  try {
    if (remote) {
      console.log(dim(`    Branch kept: ${remote.branch}`));
      const messages = await remote.commitMessages(4);
      console.log(dim("    Last commits:"));
      messages.forEach((m) => console.log(dim(`      ${m.split("\n")[0]}`)));
    }
    for (const device of devices) {
      console.log(dim(`    Last log lines of ${device.label}:`));
      (await device.logTail(12)).forEach((line) =>
        console.log(dim(`      ${line.slice(0, 300)}`)),
      );
    }
    if (!app.running) {
      await app.launch();
    }
  } catch (err) {
    console.log(dim(`    Diagnostics failed: ${err}`));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const selected = loadScenarios().filter((e) => matches(e, options.filters));
  if (options.list) {
    selected.forEach((e) =>
      console.log(
        `${e.id}${e.scenario.tags?.length ? dim(` @${e.scenario.tags.join(" @")}`) : ""}`,
      ),
    );
    return;
  }
  if (options.clean) {
    const deleted = await Remote.deleteAll(config.branchPrefix);
    console.log(`Deleted ${deleted.length} branches${deleted.map((b) => `\n  ${b}`).join("")}`);
    return;
  }
  if (selected.length === 0) {
    throw new Error("No scenario matches the filters");
  }
  githubToken();

  if (options.build) {
    console.log("Building the plugin…");
    execSync("npm run build --silent", { cwd: ROOT, stdio: "inherit" });
  }

  const deviceNames = [
    ...new Set(selected.flatMap((e) => e.scenario.devices ?? ["a"])),
  ].sort();
  const devices = new Map<string, Device>();
  const app = new ObsidianApp(() => [...devices.values()].map((d) => d.vault));
  deviceNames.forEach((name) => devices.set(name, new Device(name, app)));

  console.log(
    `Setting up ${[...devices.values()].map((d) => d.vault).join(", ")} on ${config.sshHost}…`,
  );
  await installVmfs();
  await provision(
    app,
    [...devices.values()].map((d) => d.vault),
    Object.fromEntries(
      ["main.js", "manifest.json", "styles.css"].map((f) => [
        f,
        readFileSync(path.join(ROOT, f)),
      ]),
    ),
  );

  const runId = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*/, "")
    .replace("T", "-");
  const outcomes = new Map<string, Outcome>();
  const started = Date.now();
  for (const [index, entry] of selected.entries()) {
    const outcome = await runScenario(entry, index, runId, app, devices, options);
    outcomes.set(entry.id, outcome);
    if (outcome === "failed" && options.bail) {
      break;
    }
  }

  const count = (o: Outcome) => [...outcomes.values()].filter((v) => v === o).length;
  const minutes = ((Date.now() - started) / 60000).toFixed(1);
  console.log(
    `\n${green(`${count("passed")} passed`)}, ${red(`${count("failed")} failed`)}, ` +
      `${yellow(`${count("known bug")} known bugs`)}` +
      `${count("known bug passed") ? yellow(`, ${count("known bug passed")} known bugs passed`) : ""}` +
      `${selected.length > outcomes.size ? `, ${selected.length - outcomes.size} not run` : ""}` +
      dim(` in ${minutes}m`),
  );
  for (const [id, outcome] of outcomes) {
    if (outcome === "failed") console.log(red(`  ✗ ${id}`));
    if (outcome === "known bug passed") console.log(yellow(`  ? ${id}`));
  }
  process.exitCode = count("failed") > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(red(`E2E run failed: ${err instanceof Error ? err.message : err}`));
  process.exitCode = 1;
});
