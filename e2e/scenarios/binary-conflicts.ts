// Conflicts on files that aren't text: they can't be merged, so the
// conflicts view keeps one version whole. The harness answers in its place,
// see the conflicts option of Device.sync.
import { PNG, PNG_FROM_A, PNG_FROM_B } from "../lib/fixtures";
import {
  expectEqual,
  expectInSync,
  expectLocal,
  expectRemote,
  scenario,
} from "../lib/scenario";

const devices = ["a", "b"];
const seed = { "README.md": "# Readme\n", "image.png": PNG };

export default [
  scenario({
    name: "binary conflict keeping the remote version",
    tags: ["regression"],
    devices,
    seed,
    async run({ a, b, remote, step }) {
      await step("both devices edit image.png", async () => {
        await a.write("image.png", PNG_FROM_A);
        await b.write("image.png", PNG_FROM_B);
      });
      await step("A syncs", () => a.sync());
      const result = await step("B syncs keeping the remote version", () =>
        b.sync({ conflicts: "keep-remote" }),
      );
      expectEqual(result.conflicts, ["image.png"], "conflicts");
      await expectRemote(remote, { "image.png": PNG_FROM_A });
      await expectLocal(b, { "image.png": PNG_FROM_A });
      await expectInSync(remote, [a, b]);
    },
  }),

  scenario({
    name: "binary conflict keeping the local version",
    tags: ["regression"],
    devices,
    seed,
    async run({ a, b, remote, step }) {
      await step("both devices edit image.png", async () => {
        await a.write("image.png", PNG_FROM_A);
        await b.write("image.png", PNG_FROM_B);
      });
      await step("A syncs", () => a.sync());
      await step("B syncs keeping the local version", () =>
        b.sync({ conflicts: "keep-local" }),
      );
      await expectRemote(remote, { "image.png": PNG_FROM_B });
      await expectLocal(b, { "image.png": PNG_FROM_B });
      await step("A syncs again", () => a.sync());
      await expectInSync(remote, [a, b]);
    },
  }),

  scenario({
    name: "conflict on a text file without a text extension is merged",
    tags: ["regression"],
    devices,
    seed: { "README.md": "# Readme\n", "drawing.svg": "<svg>seed</svg>\n" },
    async run({ a, b, remote, step }) {
      await step("both devices edit drawing.svg", async () => {
        await a.write("drawing.svg", "<svg>from A</svg>\n");
        await b.write("drawing.svg", "<svg>from B</svg>\n");
      });
      await step("A syncs", () => a.sync());
      const merged = "<svg>from A</svg>\n<svg>from B</svg>\n";
      await step("B syncs with the merged content", () =>
        b.sync({ conflicts: { "drawing.svg": merged } }),
      );
      await expectRemote(remote, { "drawing.svg": merged });
      await expectLocal(b, { "drawing.svg": merged });
      await step("A syncs again", () => a.sync());
      await expectInSync(remote, [a, b]);
    },
  }),
];
