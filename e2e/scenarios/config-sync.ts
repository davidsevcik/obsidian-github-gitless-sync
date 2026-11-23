// The "Sync configs" setting: the config dir is synced too.
import { expectLocal, expectRemote, scenario } from "../lib/scenario";

const devices = ["a", "b"];
const settings = { syncConfigDir: true };

export default [
  scenario({
    name: "config files travel between devices",
    devices,
    settings,
    async run({ a, b, remote, step }) {
      await step("A adds a snippet", async () => {
        await a.write(".obsidian/snippets/e2e.css", "body { color: red; }\n");
        await a.sync();
      });
      await expectRemote(remote, {
        ".obsidian/snippets/e2e.css": "body { color: red; }\n",
      });
      await step("B gets it", () => b.sync());
      await expectLocal(b, {
        ".obsidian/snippets/e2e.css": "body { color: red; }\n",
      });
      await step("A removes it", async () => {
        await a.remove(".obsidian/snippets/e2e.css");
        await a.sync();
      });
      await step("B removes it too", () => b.sync());
      await expectLocal(b, { ".obsidian/snippets/e2e.css": null });
    },
  }),

  scenario({
    name: "plugin settings and workspace are never synced",
    devices,
    settings,
    async run({ a, b, remote, step }) {
      await step("A syncs", () => a.sync());
      const files = await remote.files(true);
      for (const path of [
        ".obsidian/plugins/github-gitless-sync/data.json",
        ".obsidian/workspace.json",
      ]) {
        if (files[path]) {
          throw new Error(`${path} is in the remote`);
        }
      }
      if (!files[".obsidian/plugins/github-gitless-sync/manifest.json"]) {
        throw new Error("The plugin files are not in the remote");
      }
      await step("B keeps its own settings", async () => {
        await b.sync();
        const settings = JSON.parse(
          (await b.read(".obsidian/plugins/github-gitless-sync/data.json")) ??
            "{}",
        );
        if (settings.deviceName !== "B") {
          throw new Error(`B has the settings of ${settings.deviceName}`);
        }
      });
    },
  }),
];
