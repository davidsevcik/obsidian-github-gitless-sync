import { createHash } from "node:crypto";
import { Remote } from "./github";
import { Device, ObsidianApp, Settings, SyncResult } from "./obsidian";

export interface Scenario {
  name: string;
  // Used to select scenarios with @tag
  tags?: string[];
  // Devices syncing with the remote, each one is a vault. Defaults to ["a"]
  devices?: string[];
  // Files in the remote branch before the devices sync with it.
  // Defaults to a README.md
  seed?: Record<string, string | Uint8Array>;
  // Plugin settings for all the devices
  settings?: Settings;
  // Plugin settings for single devices, on top of settings
  deviceSettings?: Record<string, Settings>;
  // Whether every device runs its first sync, in order, before run.
  // Defaults to true
  firstSync?: boolean;
  // The scenario fails because of a known bug that's not fixed yet. It still
  // runs but doesn't fail the run, and is reported if it starts passing.
  knownBug?: string;
  run(ctx: Context): Promise<void>;
}

export interface Context {
  remote: Remote;
  obsidian: ObsidianApp;
  devices: Device[];
  // Shortcuts to the devices named "a" and "b"
  a: Device;
  b: Device;
  // Names a part of the scenario, it shows in the output and in failures
  step<T>(title: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Defines a scenario, it only helps with typing.
 */
export function scenario(definition: Scenario): Scenario {
  return definition;
}

export const DEFAULT_SEED = { "README.md": "# E2E\n" };

/**
 * The SHA git gives to a blob with this content.
 */
export function gitSha(content: string | Uint8Array): string {
  const data = Buffer.from(content);
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data]))
    .digest("hex");
}

export class AssertionError extends Error {}

function fail(message: string): never {
  throw new AssertionError(message);
}

function preview(content: Buffer | string | null): string {
  if (content === null) {
    return "missing";
  }
  const text = content.toString();
  return JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text);
}

interface FileSource {
  files(all?: boolean): Promise<Record<string, string>>;
  read(path: string): Promise<string | null>;
}

/**
 * Checks the files have exactly this content, null means the file must not
 * exist. Other files are not checked.
 */
async function expectFiles(
  where: string,
  source: FileSource,
  expected: Record<string, Content | null>,
) {
  const actual = await source.files(true);
  const wrong: string[] = [];
  for (const [path, content] of Object.entries(expected)) {
    const expectedSha = content === null ? undefined : gitSha(content);
    if (actual[path] !== expectedSha) {
      const found = actual[path] === undefined ? null : await source.read(path);
      wrong.push(
        `  ${path}: expected ${content === null ? "missing" : preview(Buffer.from(content))}, found ${preview(found)}`,
      );
    }
  }
  if (wrong.length > 0) {
    fail(`Unexpected files in ${where}:\n${wrong.join("\n")}`);
  }
}

type Content = string | Uint8Array;

export function expectRemote(
  remote: Remote,
  expected: Record<string, Content | null>,
) {
  return expectFiles(`the remote (${remote.branch})`, remote, expected);
}

export function expectLocal(
  device: Device,
  expected: Record<string, Content | null>,
) {
  return expectFiles(`device ${device.label}`, device, expected);
}

/**
 * Checks the devices have exactly the same files as the remote, the
 * hidden ones and the config dir aside.
 */
export async function expectInSync(remote: Remote, devices: Device[]) {
  const remoteFiles = await remote.files();
  const problems: string[] = [];
  for (const device of devices) {
    const localFiles = await device.files();
    const paths = new Set([
      ...Object.keys(remoteFiles),
      ...Object.keys(localFiles),
    ]);
    for (const path of [...paths].sort()) {
      if (!(path in localFiles)) {
        problems.push(`  ${path}: only in the remote, not in ${device.label}`);
      } else if (!(path in remoteFiles)) {
        problems.push(`  ${path}: only in ${device.label}, not in the remote`);
      } else if (localFiles[path] !== remoteFiles[path]) {
        problems.push(`  ${path}: differs between ${device.label} and the remote`);
      }
    }
  }
  if (problems.length > 0) {
    fail(`Devices are not in sync with the remote:\n${problems.join("\n")}`);
  }
}

/**
 * Checks the sync summary shown to the user matches all the patterns.
 */
export function expectSummary(
  result: SyncResult,
  ...patterns: (string | RegExp)[]
) {
  for (const pattern of patterns) {
    const matches =
      typeof pattern === "string"
        ? result.summary.includes(pattern)
        : pattern.test(result.summary);
    if (!matches) {
      fail(
        `Sync summary doesn't match ${pattern}, it's: ${JSON.stringify(result.summary)}`,
      );
    }
  }
}

/**
 * Checks the message of the last commit in the remote.
 */
export async function expectLastCommit(remote: Remote, pattern: string | RegExp) {
  const [message] = await remote.commitMessages(1);
  const matches =
    typeof pattern === "string" ? message === pattern : pattern.test(message);
  if (!matches) {
    fail(`Last commit doesn't match ${pattern}, it's: ${JSON.stringify(message)}`);
  }
}

export function expectEqual<T>(actual: T, expected: T, what: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    fail(`Unexpected ${what}: expected ${e}, found ${a}`);
  }
}
