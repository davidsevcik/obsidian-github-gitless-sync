import {
  DEFAULT_SETTINGS,
  GitHubSyncSettings,
} from "../../src/settings/settings";
import { config, githubToken } from "./config";
import { sleep, sshExec, vmfs, waitFor } from "./vm";

const PLUGIN_ID = config.pluginId;

/**
 * Runs an Obsidian CLI command on the VM.
 * @param vault Vault to run the command in, the focused one if null
 * @param input Sent on stdin, the command can read it with "$(cat)"
 */
async function cli(
  vault: string | null,
  command: string,
  input = "",
  timeoutMs = 120_000,
): Promise<string> {
  const target = vault ? `vault=${vault} ` : "";
  const res = await sshExec(`obsidian ${target}${command}`, input, timeoutMs);
  const out = res.stdout.trim();
  // The CLI exits with 0 even when the command fails
  if (res.code !== 0 || out.startsWith("Error:")) {
    throw new Error(
      `Obsidian CLI failed in ${vault}: ${out || res.stderr.trim()}`,
    );
  }
  return out;
}

// Once in a while the CLI never returns, so a call is given up after this
// and tried again
const CLI_CALL_TIMEOUT_MS = 20_000;
const CLI_CALL_ATTEMPTS = 3;
// How long an eval call waits for the code to end before returning, longer
// code is polled for its result
const INLINE_WAIT_MS = 10_000;

/**
 * Runs code in a vault window with the CLI, trying again if the CLI hangs.
 * The code must be safe to run more than once.
 */
async function evalOnce(vault: string, code: string): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      const out = await cli(
        vault,
        'eval code="$(cat)"',
        // The CLI runs the code in an async function, where return works,
        // only if it starts with await
        `await null;\n${code}`,
        CLI_CALL_TIMEOUT_MS,
      );
      const line = out
        .split("\n")
        .reverse()
        .find((l) => l.startsWith("=> "));
      if (line === undefined) {
        throw new Error(`Unexpected output from eval in ${vault}: ${out}`);
      }
      // The returned string is printed as is, it's JSON
      return JSON.parse(line.slice(3));
    } catch (err) {
      const hung = err instanceof Error && err.message.startsWith("Timed out");
      if (!hung || attempt >= CLI_CALL_ATTEMPTS) {
        throw err;
      }
    }
  }
}

let evalCounter = 0;

/**
 * Runs JavaScript in a vault window and returns its result.
 *
 * The code runs once, even if the CLI hangs and the call is tried again: it's
 * started under a unique id and its result is kept in the window, where
 * later calls find it.
 *
 * @param body Body of an async function, `app` is Obsidian's app and `args` the args
 * @param args Anything JSON serializable
 */
async function evaluate<T>(
  vault: string,
  body: string,
  args: unknown = null,
  timeoutMs = 300_000,
): Promise<T> {
  const id = `${process.pid}-${++evalCounter}`;
  // Encoded so that nothing in the args can break the code
  const encoded = Buffer.from(JSON.stringify(args)).toString("base64");
  const start = `
    const runs = (window.__e2e ??= {});
    for (const [key, run] of Object.entries(runs)) {
      if (Date.now() - run.started > 30 * 60 * 1000) delete runs[key];
    }
    if (!runs[${JSON.stringify(id)}]) {
      const args = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob("${encoded}"), (c) => c.charCodeAt(0))));
      const run = { started: Date.now(), result: null };
      runs[${JSON.stringify(id)}] = run;
      run.done = (async () => {\n${body}\n})().then(
        (value) => (run.result = { value: value === undefined ? null : value }),
        (err) => (run.result = { error: String(err?.message ?? err) }),
      );
    }
    const run = runs[${JSON.stringify(id)}];
    await Promise.race([run.done, new Promise((r) => setTimeout(r, ${INLINE_WAIT_MS}))]);
    return JSON.stringify(run.result);`;
  const poll = `return JSON.stringify(window.__e2e?.[${JSON.stringify(id)}]?.result ?? null);`;

  type Result = { value: T } | { error: string } | null;
  const deadline = Date.now() + timeoutMs;
  let result = (await evalOnce(vault, start)) as Result;
  while (result === null) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms running code in ${vault}`);
    }
    await sleep(1000);
    result = (await evalOnce(vault, poll)) as Result;
  }
  if ("error" in result) {
    throw new Error(`Error in ${vault}: ${result.error}`);
  }
  return result.value;
}

/**
 * The Obsidian app on the VM. Closing it closes all the devices.
 */
export class ObsidianApp {
  running = true;

  constructor(private vaults: () => string[]) {}

  async isRunning(): Promise<boolean> {
    const res = await sshExec("pgrep -x Obsidian >/dev/null && echo yes");
    return res.stdout.trim() === "yes";
  }

  async quit() {
    await sshExec(`osascript -e 'quit app "Obsidian"'`);
    await waitFor("Obsidian to quit", async () => !(await this.isRunning()));
    this.running = false;
  }

  async launch() {
    await sshExec("open -a Obsidian");
    this.running = true;
    for (const vault of this.vaults()) {
      await waitForPlugin(vault);
    }
  }

  /**
   * Closes Obsidian, runs fn, then opens Obsidian again.
   * Use it to change the vaults while the plugin can't see it.
   */
  async whileClosed(fn: () => Promise<void>) {
    await this.quit();
    try {
      await fn();
    } finally {
      await this.launch();
    }
  }
}

async function waitForPlugin(vault: string, timeoutMs = 60_000) {
  await waitFor(
    `the plugin to load in ${vault}`,
    () =>
      evaluate<boolean>(
        vault,
        `return !!app.plugins.plugins[args] && app.workspace.layoutReady;`,
        PLUGIN_ID,
      ),
    timeoutMs,
    1000,
  );
}

export type Settings = Partial<GitHubSyncSettings>;

/**
 * How to resolve sync conflicts:
 * - keep-local: the content of the device wins
 * - keep-remote: the content of the remote wins
 * - a map from file path to the content to resolve it with
 * Without one a conflict fails the sync.
 */
export type ConflictStrategy =
  | "keep-local"
  | "keep-remote"
  | Record<string, string>;

export interface SyncOptions {
  conflicts?: ConflictStrategy;
  // The sync is expected to fail, with a message matching this if it's a RegExp
  expectError?: true | RegExp;
}

export interface SyncResult {
  // Notices the sync showed, e.g. "Sync successful\nSent: added New.md"
  notices: string[];
  summary: string;
  // Paths of the files the sync found conflicts for
  conflicts: string[];
}

/**
 * Paths of files Obsidian shows in the vault, the ones we get events for.
 */
export function isVisible(filePath: string): boolean {
  return !filePath.split("/").some((segment) => segment.startsWith("."));
}

function toBase64(content: string | Uint8Array): string {
  return Buffer.from(content).toString("base64");
}

/**
 * A device syncing with the remote, it's a vault open in Obsidian on the VM.
 *
 * Methods changing files come in two flavors:
 * - create, modify, rename, delete go through the Obsidian API like the user
 *   would, so the plugin gets events for them
 * - write and remove change the files on disk, like another app would. The
 *   plugin gets no events for them if Obsidian is closed or they're hidden
 */
export class Device {
  readonly vault: string;
  // Name of the device in sync commits
  readonly label: string;

  constructor(
    readonly name: string,
    private app: ObsidianApp,
  ) {
    if (!/^[a-z0-9]+$/.test(name)) {
      throw new Error(`Invalid device name: ${name}`);
    }
    this.vault = `e2e-${name}`;
    this.label = name.toUpperCase();
  }

  private evaluate<T>(body: string, args: unknown = null): Promise<T> {
    if (!this.app.running) {
      throw new Error(`Obsidian is closed, can't use the app in ${this.vault}`);
    }
    return evaluate<T>(this.vault, body, args);
  }

  // Files on disk

  /**
   * Writes a file on disk. If Obsidian is running and shows the file, waits
   * for it to notice the change, like it would for any other app.
   */
  async write(filePath: string, content: string | Uint8Array) {
    const { size, mtime } = await vmfs<{ size: number; mtime: number }>({
      op: "write",
      vault: this.vault,
      path: filePath,
      b64: toBase64(content),
    });
    if (this.app.running && isVisible(filePath)) {
      await waitFor(`Obsidian to see ${filePath} in ${this.vault}`, () =>
        this.evaluate<boolean>(
          `const f = app.vault.getAbstractFileByPath(args.path);
           return !!f && f.stat.size === args.size && f.stat.mtime >= args.mtime - 1;`,
          { path: filePath, size, mtime: Math.floor(mtime) },
        ),
      );
      await this.settle();
    }
  }

  /**
   * Removes a file or folder from disk, see write.
   */
  async remove(filePath: string) {
    await vmfs({ op: "remove", vault: this.vault, path: filePath });
    if (this.app.running && isVisible(filePath)) {
      await waitFor(`Obsidian to see ${filePath} removed in ${this.vault}`, () =>
        this.evaluate<boolean>(
          `return !app.vault.getAbstractFileByPath(args);`,
          filePath,
        ),
      );
      await this.settle();
    }
  }

  async readBytes(filePath: string): Promise<Buffer | null> {
    const { b64 } = await vmfs<{ b64: string | null }>({
      op: "read",
      vault: this.vault,
      path: filePath,
    });
    return b64 === null ? null : Buffer.from(b64, "base64");
  }

  async read(filePath: string): Promise<string | null> {
    return (await this.readBytes(filePath))?.toString("utf8") ?? null;
  }

  /**
   * Git SHAs of the files on disk by path.
   * @param all Include hidden files and the config dir too
   */
  async files(all = false): Promise<Record<string, string>> {
    const { files } = await vmfs<{ files: Record<string, string> }>({
      op: "list",
      vault: this.vault,
    });
    return Object.fromEntries(
      Object.entries(files).filter(([p]) => all || isVisible(p)),
    );
  }

  // Changes through the Obsidian API

  async create(filePath: string, content = "") {
    await this.evaluate(
      `const folder = args.path.split("/").slice(0, -1).join("/");
       if (folder && !app.vault.getAbstractFileByPath(folder)) {
         await app.vault.createFolder(folder);
       }
       await app.vault.create(args.path, args.content);`,
      { path: filePath, content },
    );
    await this.settle();
  }

  async modify(filePath: string, content: string) {
    await this.evaluate(
      `const file = app.vault.getFileByPath(args.path);
       if (!file) throw new Error("No such file: " + args.path);
       await app.vault.modify(file, args.content);`,
      { path: filePath, content },
    );
    await this.settle();
  }

  async rename(from: string, to: string) {
    await this.evaluate(
      `const file = app.vault.getAbstractFileByPath(args.from);
       if (!file) throw new Error("No such file: " + args.from);
       const folder = args.to.split("/").slice(0, -1).join("/");
       if (folder && !app.vault.getAbstractFileByPath(folder)) {
         await app.vault.createFolder(folder);
       }
       await app.fileManager.renameFile(file, args.to);`,
      { from, to },
    );
    await this.settle();
  }

  /**
   * Deletes a file or folder the way the user would, following the
   * "Deleted files" setting.
   */
  async delete(filePath: string) {
    await this.evaluate(
      `const file = app.vault.getAbstractFileByPath(args);
       if (!file) throw new Error("No such file: " + args);
       await app.fileManager.trashFile(file);`,
      filePath,
    );
    await this.settle();
  }

  /**
   * Waits for the plugin to handle the events of the last change.
   */
  private async settle() {
    await sleep(500);
    await this.evaluate(
      `await app.plugins.plugins[args]?.syncManager.metadataStore.writeQueue;`,
      PLUGIN_ID,
    );
  }

  // Plugin

  async disablePlugin() {
    await this.evaluate(`await app.plugins.disablePlugin(args);`, PLUGIN_ID);
  }

  async enablePlugin() {
    await this.evaluate(`await app.plugins.enablePlugin(args);`, PLUGIN_ID);
    await waitForPlugin(this.vault);
  }

  /**
   * Syncs like the "Sync with GitHub" command and waits for it to end.
   * Fails if the sync shows an error, unless it's expected.
   */
  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    const result = await this.evaluate<SyncResult>(
      `const plugin = app.plugins.plugins[args.pluginId];
       if (!plugin) throw new Error("The plugin is not loaded");
       document.querySelectorAll(".notice").forEach((n) => n.remove());
       const conflicts = [];
       // Replaces the conflicts view, it would wait for the user
       plugin.syncManager.onConflicts = async (found) => {
         conflicts.push(...found.map((c) => c.filePath));
         const strategy = args.conflicts;
         if (!strategy) {
           throw new Error("Unexpected conflicts: " + found.map((c) => c.filePath).join(", "));
         }
         return found.map((c) => ({
           filePath: c.filePath,
           content: strategy === "keep-local" ? c.localContent
             : strategy === "keep-remote" ? c.remoteContent
             : strategy[c.filePath],
         }));
       };
       await plugin.sync();
       await plugin.syncManager.metadataStore.writeQueue;
       const notices = [...document.querySelectorAll(".notice")]
         .map((n) => (n.textContent ?? "").trim())
         .filter((t) => t !== "Syncing...");
       return { notices, summary: notices.join("\\n"), conflicts };`,
      { pluginId: PLUGIN_ID, conflicts: options.conflicts ?? null },
    );
    // Downloaded files trigger events too
    await this.settle();

    const error = result.notices.find((n) => n.startsWith("Error syncing"));
    if (options.expectError) {
      if (!error) {
        throw new Error(
          `Expected the sync on ${this.label} to fail, it showed: ${result.summary}`,
        );
      }
      if (
        options.expectError instanceof RegExp &&
        !options.expectError.test(error)
      ) {
        throw new Error(
          `Sync on ${this.label} failed with an unexpected error: ${error}`,
        );
      }
    } else if (error) {
      throw new Error(`Sync on ${this.label} failed: ${error}`);
    }
    return result;
  }

  /**
   * The plugin metadata stored in the vault.
   */
  async metadata(): Promise<{ files: Record<string, { sha: string | null }> }> {
    const content = await this.read(".obsidian/github-sync-metadata.json");
    if (content === null) {
      throw new Error(`No metadata in ${this.vault}`);
    }
    return JSON.parse(content);
  }

  async logTail(lines = 20): Promise<string[]> {
    const content = await this.read(".obsidian/github-sync.log");
    return (content ?? "").trim().split("\n").slice(-lines);
  }

  // Setup

  /**
   * Empties the vault and sets the plugin up to sync with the branch, as if
   * it had just been installed.
   */
  async reset(branch: string, settings: Settings) {
    const [owner, repo] = config.repo.split("/");
    const full: GitHubSyncSettings = {
      ...DEFAULT_SETTINGS,
      githubOwner: owner,
      githubRepo: repo,
      githubBranch: branch,
      deviceName: this.label,
      enableLogging: true,
      ...settings,
      githubToken: githubToken(),
    };
    await this.disablePlugin();
    await vmfs({ op: "reset", vault: this.vault, settings: full });
    await waitFor(`Obsidian to see ${this.vault} emptied`, () =>
      this.evaluate<boolean>(`return app.vault.getAllLoadedFiles().length === 1;`),
    );
    await this.enablePlugin();
  }
}

/**
 * Makes sure the vaults exist, Obsidian opens them, and the plugin build
 * installed in them is the one given.
 */
export async function provision(
  app: ObsidianApp,
  vaults: string[],
  pluginFiles: Record<string, Buffer>,
) {
  await vmfs({ op: "provision", vaults });
  await vmfs({
    op: "installPlugin",
    vaults,
    files: Object.fromEntries(
      Object.entries(pluginFiles).map(([name, data]) => [name, toBase64(data)]),
    ),
  });

  const { missing } = await vmfs<{ missing: string[] }>({
    op: "registration",
    vaults,
  });
  const running = await app.isRunning();
  if (missing.length > 0 && running) {
    // Obsidian overwrites its config when closing
    await app.quit();
  }
  if (missing.length > 0) {
    await vmfs({ op: "register", vaults });
  }
  if (missing.length > 0 || !running) {
    await sshExec("open -a Obsidian");
  }
  app.running = true;

  for (const vault of vaults) {
    await waitFor(`Obsidian to open ${vault}`, async () => {
      await cli(vault, "vault info=name");
      return true;
    }, 60_000, 1000);
    if ((await cli(vault, "plugins:restrict")) === "on") {
      // A new vault doesn't run community plugins until told so
      await cli(vault, "plugins:restrict off");
      await sleep(3000);
    }
    // Load the build we just installed
    await waitFor(`the plugin to reload in ${vault}`, async () => {
      await cli(vault, `plugin:reload id=${PLUGIN_ID}`);
      return true;
    });
    await waitForPlugin(vault);
  }
}
