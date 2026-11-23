// Two devices syncing with the same remote.
import {
  expectEqual,
  expectInSync,
  expectLocal,
  expectRemote,
  expectSummary,
  scenario,
} from "../lib/scenario";

const devices = ["a", "b"];

export default [
  scenario({
    name: "changes travel between devices",
    tags: ["smoke"],
    devices,
    async run({ a, b, remote, step }) {
      await step("A creates a note", async () => {
        await a.create("Shared.md", "v1\n");
        await a.sync();
      });
      await step("B gets it", async () => {
        expectSummary(await b.sync(), "Received: downloaded Shared.md");
        await expectLocal(b, { "Shared.md": "v1\n" });
      });
      await step("B edits it", async () => {
        await b.modify("Shared.md", "v2\n");
        expectSummary(await b.sync(), "Sent: updated Shared.md");
      });
      await step("A gets the edit", async () => {
        expectSummary(await a.sync(), "Received: downloaded Shared.md");
        await expectLocal(a, { "Shared.md": "v2\n" });
      });
      await step("B deletes it", async () => {
        await b.delete("Shared.md");
        expectSummary(await b.sync(), "Sent: deleted Shared.md");
      });
      await step("A deletes it too", async () => {
        expectSummary(await a.sync(), "Received: deleted Shared.md");
        await expectLocal(a, { "Shared.md": null });
      });
      await expectInSync(remote, [a, b]);
    },
  }),

  scenario({
    name: "renames travel between devices",
    devices,
    async run({ a, b, remote, step }) {
      await step("A renames README.md", async () => {
        await a.rename("README.md", "Docs/Intro.md");
        await a.sync();
      });
      await step("B gets the rename", async () => {
        await b.sync();
        await expectLocal(b, { "README.md": null, "Docs/Intro.md": "# E2E\n" });
      });
      await expectInSync(remote, [a, b]);
    },
  }),

  scenario({
    name: "different files changed on both devices merge",
    devices,
    seed: { "One.md": "1\n", "Two.md": "2\n" },
    async run({ a, b, remote, step }) {
      await step("both devices change different files", async () => {
        await a.modify("One.md", "1 from A\n");
        await a.create("A.md", "a\n");
        await b.modify("Two.md", "2 from B\n");
        await b.create("B.md", "b\n");
      });
      await step("A syncs, then B", async () => {
        await a.sync();
        const result = await b.sync();
        expectEqual(result.conflicts, [], "conflicts");
      });
      await step("A syncs again", () => a.sync());
      await expectRemote(remote, {
        "One.md": "1 from A\n",
        "Two.md": "2 from B\n",
        "A.md": "a\n",
        "B.md": "b\n",
      });
      await expectInSync(remote, [a, b]);
    },
  }),

  scenario({
    name: "same file created on both devices is a conflict",
    devices,
    async run({ a, b, remote, step }) {
      await step("both devices create Same.md", async () => {
        await a.create("Same.md", "from A\n");
        await b.create("Same.md", "from B\n");
      });
      await step("A syncs", () => a.sync());
      const result = await step("B syncs keeping its content", () =>
        b.sync({ conflicts: "keep-local" }),
      );
      expectEqual(result.conflicts, ["Same.md"], "conflicts");
      await step("A syncs again", () => a.sync());
      await expectRemote(remote, { "Same.md": "from B\n" });
      await expectInSync(remote, [a, b]);
    },
  }),

  scenario({
    name: "concurrent edits are a conflict resolved keeping the remote",
    tags: ["smoke"],
    devices,
    async run({ a, b, remote, step }) {
      await step("both devices edit README.md", async () => {
        await a.modify("README.md", "# From A\n");
        await b.modify("README.md", "# From B\n");
      });
      await step("A syncs", () => a.sync());
      const result = await step("B syncs keeping the remote content", () =>
        b.sync({ conflicts: "keep-remote" }),
      );
      expectEqual(result.conflicts, ["README.md"], "conflicts");
      await expectLocal(b, { "README.md": "# From A\n" });
      await step("A syncs again", () => a.sync());
      await expectInSync(remote, [a, b]);
    },
  }),

  scenario({
    name: "concurrent edits are a conflict resolved with merged content",
    devices,
    async run({ a, b, remote, step }) {
      const merged = "# From A\n# From B\n";
      await step("both devices edit README.md", async () => {
        await a.modify("README.md", "# From A\n");
        await b.modify("README.md", "# From B\n");
      });
      await step("A syncs", () => a.sync());
      await step("B syncs merging the edits", () =>
        b.sync({ conflicts: { "README.md": merged } }),
      );
      await expectLocal(b, { "README.md": merged });
      await expectRemote(remote, { "README.md": merged });
      await step("A syncs again", async () => {
        const result = await a.sync();
        expectEqual(result.conflicts, [], "conflicts");
      });
      await expectLocal(a, { "README.md": merged });
    },
  }),

  scenario({
    name: "file deleted on a device and edited later on the other is kept",
    knownBug:
      "a downloaded file is written before it's marked as just downloaded, so its create event is taken for the user's and the first real edit is ignored",
    devices,
    seed: { "README.md": "# E2E\n", "Contested.md": "v1\n" },
    async run({ a, b, remote, step }) {
      await step("A deletes it", async () => {
        await a.delete("Contested.md");
        await a.sync();
      });
      await step("B edits it after the deletion", async () => {
        await b.modify("Contested.md", "v2\n");
        await b.sync();
      });
      await expectRemote(remote, { "Contested.md": "v2\n" });
      await step("A gets it back", () => a.sync());
      await expectLocal(a, { "Contested.md": "v2\n" });
      await expectInSync(remote, [a, b]);
    },
  }),

  scenario({
    name: "file edited on a device and deleted later on the other is deleted",
    devices,
    seed: { "README.md": "# E2E\n", "Contested.md": "v1\n" },
    async run({ a, b, remote, step }) {
      await step("A edits it", async () => {
        await a.modify("Contested.md", "v2\n");
        await a.sync();
      });
      await step("B deletes it after the edit", async () => {
        await b.delete("Contested.md");
        await b.sync();
      });
      await step("A syncs", () => a.sync());
      await expectRemote(remote, { "Contested.md": null });
      await expectLocal(a, { "Contested.md": null });
      await expectInSync(remote, [a, b]);
    },
  }),

  scenario({
    name: "file created on a device while the other was closed",
    tags: ["regression"],
    devices,
    async run({ a, b, remote, obsidian, step }) {
      await step("write a file in B while Obsidian is closed", () =>
        obsidian.whileClosed(() => b.write("Offline B.md", "from B\n")),
      );
      await step("B syncs, then A", async () => {
        await b.sync();
        await a.sync();
      });
      await expectLocal(a, { "Offline B.md": "from B\n" });
      await expectInSync(remote, [a, b]);
    },
  }),
];
