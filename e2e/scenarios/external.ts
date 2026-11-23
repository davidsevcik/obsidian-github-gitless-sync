// Commits made to the remote outside of the plugin, with git, on the GitHub
// website or by GitHub Actions. They don't update the manifest.
import {
  expectEqual,
  expectInSync,
  expectLocal,
  expectRemote,
  expectSummary,
  scenario,
} from "../lib/scenario";
import { PNG } from "../lib/fixtures";

export default [
  scenario({
    name: "files added outside of the plugin are downloaded",
    tags: ["smoke"],
    async run({ a, remote, step }) {
      await step("commit new files", () =>
        remote.commit({
          write: { "Added.md": "added by git\n", "Assets/image.png": PNG },
        }),
      );
      const result = await step("sync", () => a.sync());
      expectSummary(result, "Received: 2 downloaded");
      await expectLocal(a, {
        "Added.md": "added by git\n",
        "Assets/image.png": PNG,
      });
    },
  }),

  scenario({
    name: "files changed outside of the plugin are downloaded",
    async run({ a, remote, step }) {
      await step("commit a change", () =>
        remote.commit({ write: { "README.md": "# Changed by git\n" } }),
      );
      const result = await step("sync", () => a.sync());
      expectSummary(result, "Received: downloaded README.md");
      await expectLocal(a, { "README.md": "# Changed by git\n" });
      await step("sync again", async () =>
        expectSummary(await a.sync(), "Nothing to sync"),
      );
    },
  }),

  scenario({
    name: "files deleted outside of the plugin are deleted locally",
    seed: { "README.md": "# E2E\n", "Doomed.md": "bye\n" },
    async run({ a, remote, step }) {
      await step("commit a deletion", () =>
        remote.commit({ delete: ["Doomed.md"] }),
      );
      const result = await step("sync", () => a.sync());
      expectSummary(result, "Received: deleted Doomed.md");
      await expectLocal(a, { "Doomed.md": null });
      await expectInSync(remote, [a]);
    },
  }),

  scenario({
    name: "file deleted outside of the plugin but edited locally is kept",
    seed: { "README.md": "# E2E\n", "Precious.md": "v1\n" },
    async run({ a, remote, step }) {
      await step("commit a deletion", () =>
        remote.commit({ delete: ["Precious.md"] }),
      );
      await step("edit the file locally", () =>
        a.modify("Precious.md", "v2\n"),
      );
      await step("sync", () => a.sync());
      await expectLocal(a, { "Precious.md": "v2\n" });
      await expectRemote(remote, { "Precious.md": "v2\n" });
    },
  }),

  scenario({
    name: "file changed outside of the plugin and locally is a conflict",
    async run({ a, remote, step }) {
      await step("commit a change", () =>
        remote.commit({ write: { "README.md": "# Remote\n" } }),
      );
      await step("edit the file locally", () =>
        a.modify("README.md", "# Local\n"),
      );
      const result = await step("sync keeping the local content", () =>
        a.sync({ conflicts: "keep-local" }),
      );
      expectEqual(result.conflicts, ["README.md"], "conflicts");
      await expectRemote(remote, { "README.md": "# Local\n" });
      await expectLocal(a, { "README.md": "# Local\n" });
    },
  }),

  scenario({
    name: "files in hidden folders added outside of the plugin are downloaded",
    async run({ a, remote, step }) {
      // Not in .github/workflows, writing there needs a token with the
      // workflow permission
      await step("commit an issue template", () =>
        remote.commit({
          write: { ".github/ISSUE_TEMPLATE/bug.md": "# Bug\n" },
        }),
      );
      const result = await step("sync", () => a.sync());
      expectSummary(result, "Received: downloaded .github/ISSUE_TEMPLATE/bug.md");
      await expectLocal(a, { ".github/ISSUE_TEMPLATE/bug.md": "# Bug\n" });
    },
  }),
];
