# E2E tests

End to end tests of the plugin: the real build runs in Obsidian on a macOS VM and syncs with a real GitHub repository. Each scenario changes files the way a user, another app or another device would, syncs, and checks the vaults and the repository.

## Running

```sh
export E2E_GITHUB_TOKEN=...   # token with read and write access to the contents of the test repository
npm run e2e                   # builds the plugin and runs all the scenarios
npm run e2e -- @smoke         # only the scenarios tagged smoke, about 3 minutes
npm run e2e -- @gui           # only the scenarios using the conflicts view with the mouse, about 4 minutes
npm run e2e -- offline rename # only the scenarios whose id contains offline or rename
npm run e2e -- --list         # lists the scenarios, with their tags
```

Options:

- `--no-build` uses the `main.js` already built
- `--keep` keeps the branches of passed scenarios too, failed ones are always kept
- `--bail` stops at the first failure
- `--clean` deletes all the `e2e/` branches, like the ones kept by failed scenarios, and runs nothing

A run exits with 1 if any scenario failed.

## Requirements

- An SSH host, `agent-vm` by default, running macOS with Obsidian, Homebrew and the Obsidian CLI installed. Turn the CLI on in Obsidian under Settings > General > Advanced > Command line interface.
- For the `gui` scenarios, [peekaboo](https://github.com/steipete/peekaboo) on the VM, with the Accessibility and Screen Recording permissions. A user must be logged in to the VM's screen.
- A GitHub repository the token can write to, `kitt-assist/tmp` by default. A fine-grained token needs only the Contents read and write permission. Without the Workflows permission GitHub refuses changes to `.github/workflows`, so scenarios must not write there.

The runner sets everything else up: it creates the vaults `~/Vaults/e2e-a` and `~/Vaults/e2e-b` on the VM, registers them with Obsidian, turns off restricted mode in them, and installs the plugin build. Obsidian is restarted only if it must register a new vault.

| Variable           | Default           | Purpose                                     |
| ------------------ | ----------------- | ------------------------------------------- |
| `E2E_GITHUB_TOKEN` | required          | GitHub token, never printed                 |
| `E2E_REPO`         | `kitt-assist/tmp` | repository the scenarios sync with          |
| `E2E_SSH_HOST`     | `agent-vm`        | VM running Obsidian                         |
| `E2E_VAULTS_DIR`   | `Vaults`          | folder of the vaults, relative to the VM home |

## How a scenario runs

1. A new branch `e2e/<run>-<n>-<name>` is created in the repository with the `seed` files and no history.
2. The vault of each device is emptied and the plugin is set up to sync with the branch, as if just installed. The token travels to the VM on stdin and is written only in the plugin settings, which the plugin never syncs.
3. Each device runs its first sync, in order.
4. `run` does its thing.
5. The branch is deleted if the scenario passed. If it failed the branch is kept, and the output shows the step that failed, the last commits, the last lines of the plugin log of each device and where the screenshot of each device's window is.

Screenshots go to `e2e/screenshots/<run>/<n>-<scenario>/`, which git ignores.

Scenarios run one at a time, they share the vaults and the Obsidian app.

## Writing a scenario

Scenarios tagged `gui` (`scenarios/conflicts-view.ts`) open the conflicts view and use it with the mouse. Prefer them only for what needs the view, the rest is faster through the API.

Scenarios live in `scenarios/`, grouped by file. Each file exports an array of scenarios as default, a new file is picked up automatically. A scenario's id is `<file>/<name>`.

```ts
import { expectRemote, expectSummary, scenario } from "../lib/scenario";

export default [
  scenario({
    name: "files created while Obsidian is closed are uploaded",
    tags: ["regression"],
    async run({ a, remote, obsidian, step }) {
      await step("write a file while Obsidian is closed", () =>
        obsidian.whileClosed(() => a.write("Closed.md", "hello\n")),
      );
      expectSummary(await step("sync", () => a.sync()), "Sent: added Closed.md");
      await expectRemote(remote, { "Closed.md": "hello\n" });
    },
  }),
];
```

Scenario fields, all optional but `name` and `run`:

- `devices`: names of the devices, `["a"]` by default. `["a", "b"]` gives two devices syncing with the same branch.
- `seed`: files in the branch before the first sync, a `README.md` by default.
- `settings`: plugin settings for all the devices, e.g. `{ syncConfigDir: true }`. `deviceSettings` sets them for a single device: `{ b: { conflictHandling: "overwriteLocal" } }`.
- `firstSync: false` skips the first syncs, to test them yourself.
- `tags`: select scenarios with `@tag`. `smoke` marks a quick set covering the main paths, `regression` the scenarios for fixed bugs.
- `knownBug`: the scenario fails because of a bug not fixed yet. It still runs, but doesn't fail the run, and the output says so if it starts passing.

What `run` gets:

- `a`, `b`, `devices`: the devices, see `Device` in `lib/obsidian.ts`.
  - Through the Obsidian API, so the plugin gets events: `create`, `modify`, `rename`, `delete`.
  - On disk, like another app would: `write`, `remove`. If Obsidian is running and the file is not hidden they wait for Obsidian to notice.
  - Reading: `read`, `readBytes`, `files`, `metadata`, `logTail`.
  - `sync()` syncs like the "Sync with GitHub" command and returns the notices it showed. A sync showing an error fails the scenario, unless `expectError` is set. A conflict fails it too, unless `conflicts` says how to resolve it: `"keep-local"`, `"keep-remote"` or a map from path to content.
  - `disablePlugin`, `enablePlugin`.
  - `startSync()` syncs with the real conflicts view: it returns once the sync has started, and `result()` waits for the end. Resolve the conflicts with `window` meanwhile.
  - `window`: the vault's window, used like the user would, see `AppWindow` in `lib/ui.ts`. `click("Keep local")` finds the element showing that text or with that label and clicks its center with the mouse. It looks in the topmost layer (an open menu, else a modal, else the conflicts view), unless `within` says where. A click fails if the text matches several elements and `nth` doesn't pick one, or if something else covers the element, as it would stop the user. `focus({ width, height })` resizes the window, under 600 pixels wide it's laid out like a phone, without the sidebar. `waitForConflictsView`, `waitForText`, `texts`, `boxes` and `inspect` read what the window shows, and `screenshot(name)` saves a screenshot of it.
- `remote`: the branch, see `lib/github.ts`. `commit` changes it outside of the plugin, like git would. `files`, `read`, `manifest` and `commitMessages` read it.
- `obsidian.whileClosed(fn)`: closes Obsidian, runs `fn`, and opens it again. It closes all the devices.
- `step(title, fn)`: names a part of the scenario for the output and for failures.

Assertions are in `lib/scenario.ts`: `expectLocal`, `expectRemote` (a path mapped to `null` must not exist), `expectInSync` (devices have exactly the remote files, hidden ones aside), `expectSummary`, `expectLastCommit` and `expectEqual`.

Run `npm run e2e:check` to type-check the tests, the plugin build doesn't include them.
