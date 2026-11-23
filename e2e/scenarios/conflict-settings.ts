// The "Conflict handling" setting. With "ask" the conflicts view opens, the
// harness answers in its place, see the conflicts option of Device.sync.
import { expectInSync, expectLocal, expectRemote, scenario } from "../lib/scenario";

const devices = ["a", "b"];

export default [
  scenario({
    name: "overwrite local setting keeps the remote content",
    knownBug:
      "both overwrite modes build their actions from conflictResolutions, which is empty for them, so the local file is uploaded",
    devices,
    deviceSettings: { b: { conflictHandling: "overwriteLocal" } },
    async run({ a, b, remote, step }) {
      await step("both devices edit README.md", async () => {
        await a.modify("README.md", "# From A\n");
        await b.modify("README.md", "# From B\n");
      });
      await step("A syncs, then B", async () => {
        await a.sync();
        await b.sync();
      });
      await expectRemote(remote, { "README.md": "# From A\n" });
      await expectLocal(b, { "README.md": "# From A\n" });
      await expectInSync(remote, [a, b]);
    },
  }),

  scenario({
    name: "overwrite remote setting keeps the local content",
    devices,
    deviceSettings: { b: { conflictHandling: "overwriteRemote" } },
    async run({ a, b, remote, step }) {
      await step("both devices edit README.md", async () => {
        await a.modify("README.md", "# From A\n");
        await b.modify("README.md", "# From B\n");
      });
      await step("A syncs, then B", async () => {
        await a.sync();
        await b.sync();
      });
      await expectRemote(remote, { "README.md": "# From B\n" });
      await expectLocal(b, { "README.md": "# From B\n" });
      await step("A syncs again", () => a.sync());
      await expectInSync(remote, [a, b]);
    },
  }),
];
