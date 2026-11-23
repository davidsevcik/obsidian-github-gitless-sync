// Files that must not be synced: ignored by the .gitignore, hidden, or
// device specific.
import {
  expectInSync,
  expectLocal,
  expectRemote,
  expectSummary,
  scenario,
} from "../lib/scenario";

export default [
  scenario({
    name: "files matching the .gitignore are not synced",
    tags: ["smoke"],
    seed: {
      "README.md": "# E2E\n",
      ".gitignore": "private/\n*.tmp\n",
    },
    async run({ a, remote, step }) {
      await expectLocal(a, { ".gitignore": "private/\n*.tmp\n" });
      await step("create ignored and synced files", async () => {
        await a.create("private/secret.md", "secret\n");
        await a.create("scratch.tmp", "temporary\n");
        await a.create("public.md", "public\n");
      });
      const result = await step("sync", () => a.sync());
      expectSummary(result, "Sent: added public.md");
      await expectRemote(remote, {
        "private/secret.md": null,
        "scratch.tmp": null,
        "public.md": "public\n",
      });
    },
  }),

  scenario({
    name: "ignored files in the remote are not downloaded",
    seed: {
      "README.md": "# E2E\n",
      ".gitignore": "build/\n",
    },
    async run({ a, remote, step }) {
      await step("commit an ignored file", () =>
        remote.commit({ write: { "build/out.md": "generated\n" } }),
      );
      await step("sync", () => a.sync());
      await expectLocal(a, { "build/out.md": null });
    },
  }),

  scenario({
    name: "files written while closed that the .gitignore ignores are not synced",
    tags: ["regression"],
    seed: { "README.md": "# E2E\n", ".gitignore": "private/\n" },
    async run({ a, remote, obsidian, step }) {
      await step("write files while Obsidian is closed", () =>
        obsidian.whileClosed(async () => {
          await a.write("private/secret.md", "secret\n");
          await a.write("public.md", "public\n");
        }),
      );
      await step("sync", () => a.sync());
      await expectRemote(remote, {
        "private/secret.md": null,
        "public.md": "public\n",
      });
    },
  }),

  scenario({
    name: "hidden files are not synced, files in hidden folders are",
    async run({ a, remote, step }) {
      await step("write hidden files", async () => {
        await a.write(".hidden.md", "hidden file\n");
        await a.write(".stuff/inside.md", "in a hidden folder\n");
        await a.write("Folder/.also-hidden", "hidden file\n");
      });
      await step("sync", () => a.sync());
      await expectRemote(remote, {
        ".hidden.md": null,
        ".stuff/inside.md": "in a hidden folder\n",
        "Folder/.also-hidden": null,
      });
    },
  }),

  scenario({
    name: "files in .git and .trash folders are not synced",
    async run({ a, remote, step }) {
      await step("write files in .git and .trash", async () => {
        await a.write(".git/config", "[core]\n");
        await a.write(".trash/Deleted.md", "trashed\n");
      });
      expectSummary(await step("sync", () => a.sync()), "Nothing to sync");
      await expectRemote(remote, { ".git/config": null, ".trash/Deleted.md": null });
    },
  }),

  scenario({
    name: "config dir is not synced unless enabled",
    async run({ a, remote, step }) {
      await step("add a snippet", () =>
        a.write(".obsidian/snippets/e2e.css", "body {}\n"),
      );
      expectSummary(await step("sync", () => a.sync()), "Nothing to sync");
      await expectRemote(remote, { ".obsidian/snippets/e2e.css": null });
      await expectInSync(remote, [a]);
    },
  }),
];
