import {
  expectInSync,
  expectLastCommit,
  expectLocal,
  expectRemote,
  expectSummary,
  scenario,
} from "../lib/scenario";
import { PNG } from "../lib/fixtures";

export default [
  scenario({
    name: "first sync downloads the remote files",
    tags: ["smoke"],
    seed: {
      "README.md": "# E2E\n",
      "Folder/Nested.md": "nested\n",
      "Folder/Deeper/Deepest.md": "deepest\n",
      "image.png": PNG,
    },
    async run({ a, remote, step }) {
      await step("check the files", async () => {
        await expectLocal(a, {
          "README.md": "# E2E\n",
          "Folder/Nested.md": "nested\n",
          "Folder/Deeper/Deepest.md": "deepest\n",
          "image.png": PNG,
        });
        await expectInSync(remote, [a]);
      });
      await step("check the remote got the manifest", async () => {
        await expectLastCommit(remote, "First sync from A");
        const manifest = await remote.manifest();
        if (!manifest.files["Folder/Deeper/Deepest.md"]) {
          throw new Error("The manifest doesn't track the downloaded files");
        }
      });
    },
  }),

  scenario({
    name: "sync with no changes does nothing",
    tags: ["smoke"],
    async run({ a, remote, step }) {
      const head = await remote.head();
      const result = await step("sync", () => a.sync());
      expectSummary(result, "Nothing to sync");
      if ((await remote.head()) !== head) {
        throw new Error("A sync with nothing to sync made a commit");
      }
    },
  }),

  scenario({
    name: "note created in the app is uploaded",
    tags: ["smoke"],
    async run({ a, remote, step }) {
      await step("create New.md", () => a.create("New.md", "hello\n"));
      const result = await step("sync", () => a.sync());
      expectSummary(result, "Sent: added New.md");
      await expectRemote(remote, { "New.md": "hello\n" });
      await expectLastCommit(remote, "Add New.md (A)");
    },
  }),

  scenario({
    name: "note created in a new folder is uploaded",
    async run({ a, remote, step }) {
      await step("create Deep/er/Note.md", () =>
        a.create("Deep/er/Note.md", "deep\n"),
      );
      await step("sync", () => a.sync());
      await expectRemote(remote, { "Deep/er/Note.md": "deep\n" });
    },
  }),

  scenario({
    name: "note edited in the app is uploaded",
    tags: ["smoke"],
    async run({ a, remote, step }) {
      await step("edit README.md", () => a.modify("README.md", "# Edited\n"));
      const result = await step("sync", () => a.sync());
      expectSummary(result, "Sent: updated README.md");
      await expectRemote(remote, { "README.md": "# Edited\n" });
      await expectLastCommit(remote, "Update README.md (A)");
    },
  }),

  scenario({
    name: "note renamed in the app is moved in the remote",
    async run({ a, remote, step }) {
      await step("rename README.md", () =>
        a.rename("README.md", "Moved/Renamed.md"),
      );
      await step("sync", () => a.sync());
      await expectRemote(remote, {
        "README.md": null,
        "Moved/Renamed.md": "# E2E\n",
      });
      await expectLastCommit(remote, /^Sync from A: 1 added, 1 deleted/);
    },
  }),

  scenario({
    name: "note deleted in the app is deleted in the remote",
    tags: ["smoke"],
    seed: { "README.md": "# E2E\n", "Doomed.md": "bye\n" },
    async run({ a, remote, step }) {
      await step("delete Doomed.md", () => a.delete("Doomed.md"));
      const result = await step("sync", () => a.sync());
      expectSummary(result, "Sent: deleted Doomed.md");
      await expectRemote(remote, { "Doomed.md": null, "README.md": "# E2E\n" });
      await expectLastCommit(remote, "Delete Doomed.md (A)");
      const manifest = await remote.manifest();
      if (!manifest.files["Doomed.md"]?.deleted) {
        throw new Error("The manifest doesn't track the file as deleted");
      }
    },
  }),

  scenario({
    name: "folder deleted in the app is deleted in the remote",
    seed: {
      "README.md": "# E2E\n",
      "Old/One.md": "1\n",
      "Old/Sub/Two.md": "2\n",
    },
    async run({ a, remote, step }) {
      await step("delete the Old folder", () => a.delete("Old"));
      await step("sync", () => a.sync());
      await expectRemote(remote, { "Old/One.md": null, "Old/Sub/Two.md": null });
      await expectInSync(remote, [a]);
    },
  }),

  scenario({
    name: "binary file is uploaded unchanged",
    async run({ a, remote, step }) {
      await step("add image.png", () => a.write("image.png", PNG));
      await step("sync", () => a.sync());
      await expectRemote(remote, { "image.png": PNG });
    },
  }),

  scenario({
    name: "file names with spaces and accents are synced",
    async run({ a, remote, step }) {
      await step("create the notes", async () => {
        await a.create("Poznámky/Příliš žluťoučký kůň.md", "ěščřžýáíé\n");
        await a.create("With spaces & symbols (1).md", "ok\n");
      });
      await step("sync", () => a.sync());
      await expectRemote(remote, {
        "Poznámky/Příliš žluťoučký kůň.md": "ěščřžýáíé\n",
        "With spaces & symbols (1).md": "ok\n",
      });
      await step("sync again", async () =>
        expectSummary(await a.sync(), "Nothing to sync"),
      );
    },
  }),
];
