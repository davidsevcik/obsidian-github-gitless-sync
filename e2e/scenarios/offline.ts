// Changes the plugin gets no events for: made while Obsidian is closed or the
// plugin is disabled, e.g. by another app or another sync tool.
import {
  expectInSync,
  expectLocal,
  expectRemote,
  expectSummary,
  scenario,
} from "../lib/scenario";

export default [
  scenario({
    name: "files created while Obsidian is closed are uploaded",
    tags: ["smoke", "regression"],
    async run({ a, remote, obsidian, step }) {
      await step("write files while Obsidian is closed", () =>
        obsidian.whileClosed(async () => {
          await a.write("Closed.md", "written while closed\n");
          await a.write("Sub/Nested.md", "nested\n");
        }),
      );
      const result = await step("sync", () => a.sync());
      expectSummary(result, "Sent: 2 added");
      await expectRemote(remote, {
        "Closed.md": "written while closed\n",
        "Sub/Nested.md": "nested\n",
      });
    },
  }),

  scenario({
    name: "files edited while Obsidian is closed are uploaded",
    async run({ a, remote, obsidian, step }) {
      await step("edit README.md while Obsidian is closed", () =>
        obsidian.whileClosed(() => a.write("README.md", "# Edited offline\n")),
      );
      const result = await step("sync", () => a.sync());
      expectSummary(result, "Sent: updated README.md");
      await expectRemote(remote, { "README.md": "# Edited offline\n" });
    },
  }),

  scenario({
    name: "files deleted while Obsidian is closed are deleted in the remote",
    tags: ["regression"],
    seed: { "README.md": "# E2E\n", "Doomed.md": "bye\n" },
    async run({ a, remote, obsidian, step }) {
      await step("delete Doomed.md while Obsidian is closed", () =>
        obsidian.whileClosed(() => a.remove("Doomed.md")),
      );
      const result = await step("sync", () => a.sync());
      expectSummary(result, "Sent: deleted Doomed.md");
      await expectRemote(remote, { "Doomed.md": null });
    },
  }),

  scenario({
    name: "files renamed while Obsidian is closed are moved in the remote",
    tags: ["regression"],
    async run({ a, remote, obsidian, step }) {
      await step("move README.md while Obsidian is closed", () =>
        obsidian.whileClosed(async () => {
          await a.remove("README.md");
          await a.write("Archive/README.md", "# E2E\n");
        }),
      );
      await step("sync", () => a.sync());
      await expectRemote(remote, {
        "README.md": null,
        "Archive/README.md": "# E2E\n",
      });
      await expectInSync(remote, [a]);
    },
  }),

  scenario({
    name: "files created while the plugin is disabled are uploaded",
    tags: ["regression"],
    async run({ a, remote, step }) {
      await step("write a file with the plugin disabled", async () => {
        await a.disablePlugin();
        await a.write("While disabled.md", "nobody listening\n");
        await a.enablePlugin();
      });
      await step("sync", () => a.sync());
      await expectRemote(remote, {
        "While disabled.md": "nobody listening\n",
      });
    },
  }),

  scenario({
    name: "files written by another app while Obsidian is open are uploaded",
    async run({ a, remote, step }) {
      await step("write a file on disk", () =>
        a.write("From another app.md", "external editor\n"),
      );
      await step("sync", () => a.sync());
      await expectRemote(remote, { "From another app.md": "external editor\n" });
    },
  }),

  scenario({
    name: "remote changes are downloaded after Obsidian was closed",
    async run({ a, remote, obsidian, step }) {
      await step("change the remote while Obsidian is closed", () =>
        obsidian.whileClosed(async () => {
          await remote.commit({ write: { "Remote.md": "from remote\n" } });
        }),
      );
      await step("sync", () => a.sync());
      await expectLocal(a, { "Remote.md": "from remote\n" });
    },
  }),
];
