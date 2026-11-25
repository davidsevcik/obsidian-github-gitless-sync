// The conflicts view, used with the mouse like the user would: the sync
// opens the real view and the scenario clicks its buttons in the window.
// Each scenario saves screenshots of the view, see e2e/README.md.
import { BLUE_PNG, BROKEN_IMAGE, PNG, RED_PNG } from "../lib/fixtures";
import { Device, PendingSync } from "../lib/obsidian";
import { VIEW } from "../lib/ui";
import {
  expectEqual,
  expectInSync,
  expectLocal,
  expectRemote,
  scenario,
} from "../lib/scenario";

const devices = ["a", "b"];
const tags = ["gui"];

/**
 * A and B write their versions of the files, A syncs them, then B syncs and
 * gets the conflicts view, its window in front.
 */
async function conflict(
  a: Device,
  b: Device,
  step: <T>(title: string, fn: () => Promise<T>) => Promise<T>,
  versions: Record<string, { a: string | Uint8Array; b: string | Uint8Array }>,
): Promise<PendingSync> {
  const paths = Object.keys(versions).join(", ");
  await step(`both devices edit ${paths}`, async () => {
    for (const [path, { a: content }] of Object.entries(versions)) {
      await a.write(path, content);
    }
    for (const [path, { b: content }] of Object.entries(versions)) {
      await b.write(path, content);
    }
  });
  await step("A syncs", () => a.sync());
  return step("B syncs and gets the conflicts view", async () => {
    const pending = await b.startSync();
    await b.window.focus();
    await b.window.waitForConflictsView();
    return pending;
  });
}

/**
 * What the versions of the open binary file show: their titles, the sizes
 * of the images they show, null for no image or one that didn't load, and
 * their texts.
 */
function binaryVersions(b: Device) {
  return b.window.inspect<
    { title: string; image: [number, number] | null; text: string }[]
  >(
    `// Images load asynchronously
     for (let i = 0; i < 20; i++) {
       const images = [...view.querySelectorAll(".conflicts-binary-image")].filter(visible);
       if (images.every((img) => img.complete)) break;
       await sleep(100);
     }
     return [...view.querySelectorAll(".conflicts-binary-version")].filter(visible).map((el) => {
       const img = el.querySelector("img");
       return {
         title: ownText(el.querySelector(".conflicts-pane-header")),
         image: img && img.complete && img.naturalWidth > 0 ? [img.naturalWidth, img.naturalHeight] : null,
         text: ownText(el),
       };
     });`,
  );
}

export default [
  scenario({
    name: "binary image conflict previews both versions and keeps the remote one",
    tags,
    devices,
    seed: { "README.md": "# Readme\n", "image.png": PNG },
    async run({ a, b, remote, step }) {
      const pending = await conflict(a, b, step, {
        // A syncs first, so its version is the remote one for B
        "image.png": { a: BLUE_PNG, b: RED_PNG },
      });
      await step("the view previews both images side by side", async () => {
        const versions = await binaryVersions(b);
        expectEqual(
          versions.map((v) => [v.title, v.image]),
          [
            ["Remote", [160, 80]],
            ["Local", [120, 80]],
          ],
          "previews",
        );
        expectEqual(
          versions.map((v) => v.text.includes(`${v.title === "Remote" ? BLUE_PNG.length : RED_PNG.length} B`)),
          [true, true],
          `sizes in ${JSON.stringify(versions.map((v) => v.text))}`,
        );
        const [remoteBox, localBox] = await b.window.boxes(".conflicts-binary-version");
        expectEqual(
          { sameRow: Math.abs(remoteBox.y - localBox.y) < 2, remoteFirst: remoteBox.x < localBox.x },
          { sameRow: true, remoteFirst: true },
          "layout of the versions",
        );
        await b.window.screenshot("binary-image");
      });
      await step("B keeps the remote version", () => b.window.click("Keep remote"));
      const result = await step("the sync ends", () => pending.result());
      expectEqual(result.conflicts, ["image.png"], "conflicts");
      await b.window.waitForText("No conflicts to resolve");
      await expectRemote(remote, { "image.png": BLUE_PNG });
      await expectLocal(b, { "image.png": BLUE_PNG });
      await expectInSync(remote, [a, b]);
    },
  }),

  scenario({
    name: "binary image versions stack in a narrow window",
    tags,
    devices,
    seed: { "README.md": "# Readme\n", "image.png": PNG },
    async run({ a, b, remote, step }) {
      const pending = await conflict(a, b, step, {
        "image.png": { a: BLUE_PNG, b: RED_PNG },
      });
      await step("B's window gets as narrow as a phone", async () => {
        await b.window.focus({ width: 420, height: 800 });
        const [view] = await b.window.boxes(VIEW);
        expectEqual(view.width < 420 && view.width > 300, true, `width of the view, ${view.width}`);
      });
      await step("the versions stack, remote first", async () => {
        const versions = await binaryVersions(b);
        expectEqual(
          versions.map((v) => v.image !== null),
          [true, true],
          "images shown",
        );
        const [remoteBox, localBox] = await b.window.boxes(".conflicts-binary-version");
        expectEqual(
          localBox.y >= remoteBox.y + remoteBox.height,
          true,
          `local version under the remote one, boxes ${JSON.stringify([remoteBox, localBox])}`,
        );
        await b.window.screenshot("binary-image-narrow");
      });
      await step("B keeps the local version", () => b.window.click("Keep local"));
      await step("the sync ends", () => pending.result());
      await b.window.focus();
      await expectRemote(remote, { "image.png": RED_PNG });
      await step("A syncs again", () => a.sync());
      await expectInSync(remote, [a, b]);
    },
  }),

  scenario({
    name: "unified view lists binary files and shows the ones it can't preview",
    tags,
    devices,
    settings: { conflictViewMode: "unified" },
    seed: {
      "README.md": "# Readme\n",
      "broken.png": BROKEN_IMAGE,
      "docs/paper.pdf": Buffer.from("%PDF-1.4\n\xff\x00seed", "binary"),
    },
    async run({ a, b, remote, step }) {
      const brokenFromA = Buffer.concat([BROKEN_IMAGE, Buffer.from("A")]);
      const brokenFromB = Buffer.concat([BROKEN_IMAGE, Buffer.from("B-longer")]);
      const pdfFromA = Buffer.from("%PDF-1.4\n\xff\x00from A", "binary");
      const pdfFromB = Buffer.from("%PDF-1.4\n\xff\x00from B", "binary");
      const pending = await conflict(a, b, step, {
        "broken.png": { a: brokenFromA, b: brokenFromB },
        "docs/paper.pdf": { a: pdfFromA, b: pdfFromB },
      });
      await step("the list shows both files as binary", async () => {
        expectEqual(
          (await b.window.texts(".conflicts-file-count")),
          ["Binary file", "Binary file"],
          "file rows",
        );
        expectEqual(
          (await b.window.texts(".conflicts-accept-all-count")),
          ["2 files with conflicts"],
          "count",
        );
        await b.window.screenshot("unified-list");
      });
      await step("B opens broken.png", () => b.window.click("broken.png"));
      await step("the image versions say they can't be shown", async () => {
        const versions = await binaryVersions(b);
        expectEqual(
          versions.map((v) => [v.title, v.image, v.text.includes("Can't show this image")]),
          [
            ["Remote", null, true],
            ["Local", null, true],
          ],
          "versions",
        );
        await b.window.screenshot("unified-broken-image");
      });
      await step("B keeps the local version", () => b.window.click("Keep local"));
      await step("the view moves on to paper.pdf, without previews", async () => {
        await b.window.waitForText("paper.pdf", ".conflicts-file-screen");
        const versions = await binaryVersions(b);
        expectEqual(
          versions.map((v) => [v.title, v.image, v.text]),
          [
            ["Remote", null, `Remote ${pdfFromA.length} B Keep remote`],
            ["Local", null, `Local ${pdfFromB.length} B Keep local`],
          ],
          "versions",
        );
        await b.window.screenshot("unified-pdf");
      });
      await step("B keeps the remote version", () => b.window.click("Keep remote"));
      await step("the sync ends", () => pending.result());
      await expectRemote(remote, { "broken.png": brokenFromB, "docs/paper.pdf": pdfFromA });
      await step("A syncs again", () => a.sync());
      await expectInSync(remote, [a, b]);
    },
  }),

  scenario({
    name: "accept all local asks first and resolves text and binary files",
    tags,
    devices,
    seed: { "README.md": "# Readme\n", "Note.md": "one\ntwo\n", "image.png": PNG },
    async run({ a, b, remote, step }) {
      const pending = await conflict(a, b, step, {
        "Note.md": { a: "one from A\ntwo\n", b: "one from B\ntwo\n" },
        "image.png": { a: BLUE_PNG, b: RED_PNG },
      });
      await step("B cancels accepting all local", async () => {
        await b.window.click("Accept all local");
        await b.window.waitForText("Keep the local version of all files?", ".modal-container");
        await b.window.screenshot("accept-all-confirmation");
        await b.window.click("Cancel");
        expectEqual(
          await b.window.texts(".conflicts-accept-all-count"),
          ["2 files with conflicts"],
          "files left after cancelling",
        );
      });
      await step("B accepts all local", async () => {
        await b.window.click("Accept all local");
        await b.window.click({ text: "Keep local", within: ".modal-container" });
      });
      const result = await step("the sync ends", () => pending.result());
      expectEqual([...result.conflicts].sort(), ["Note.md", "image.png"], "conflicts");
      await expectRemote(remote, {
        "Note.md": "one from B\ntwo\n",
        "image.png": RED_PNG,
      });
      await step("A syncs again", () => a.sync());
      await expectInSync(remote, [a, b]);
    },
  }),

  scenario({
    name: "split view resolves a text conflict with the gutter buttons",
    tags,
    devices,
    seed: { "README.md": "# Readme\n", "Note.md": "one\ntwo\nthree\n" },
    async run({ a, b, remote, step }) {
      const pending = await conflict(a, b, step, {
        "Note.md": { a: "one\ntwo from A\nthree\n", b: "one\ntwo from B\nthree\n" },
      });
      await step("the view shows both versions", async () => {
        await b.window.waitForText("Resolve conflict");
        const disabled = await b.window.inspect<boolean>(
          `return find({ text: "Resolve conflict" })[0].disabled;`,
        );
        expectEqual(disabled, true, "Resolve conflict disabled with conflicts left");
        await b.window.screenshot("split-text");
      });
      await step("B takes the remote lines", () =>
        b.window.click("Use remote lines"),
      );
      await step("B resolves the file", () => b.window.click("Resolve conflict"));
      await step("the sync ends", () => pending.result());
      await expectRemote(remote, { "Note.md": "one\ntwo from A\nthree\n" });
      await expectLocal(b, { "Note.md": "one\ntwo from A\nthree\n" });
      await expectInSync(remote, [a, b]);
    },
  }),

  scenario({
    name: "unified view resolves each conflict of a text file",
    tags,
    devices,
    settings: { conflictViewMode: "unified" },
    seed: {
      "README.md": "# Readme\n",
      "Note.md": "first\n\n2\n3\n4\n5\n6\n7\n8\n9\n\nlast\n",
    },
    async run({ a, b, remote, step }) {
      const pending = await conflict(a, b, step, {
        "Note.md": {
          a: "first from A\n\n2\n3\n4\n5\n6\n7\n8\n9\n\nlast from A\n",
          b: "first from B\n\n2\n3\n4\n5\n6\n7\n8\n9\n\nlast from B\n",
        },
      });
      await step("the list counts the conflicts of Note.md", async () => {
        expectEqual(await b.window.texts(".conflicts-file-count"), ["2 conflicts"], "count");
      });
      await step("B opens Note.md", () => b.window.click("Note.md"));
      await step("the file shows its two conflicts", async () => {
        await b.window.waitForText("2 conflicts left");
        await b.window.screenshot("unified-text");
      });
      await step("B accepts remote for the first and local for the last", async () => {
        await b.window.click({ text: "Accept remote", nth: 0 });
        await b.window.waitForText("1 conflict left");
        await b.window.click({ text: "Accept local", nth: 0 });
        await b.window.waitForText("No conflicts left");
        await b.window.screenshot("unified-text-resolved");
      });
      await step("B resolves the file", () => b.window.click("Resolve conflict"));
      await step("the sync ends", () => pending.result());
      const merged = "first from A\n\n2\n3\n4\n5\n6\n7\n8\n9\n\nlast from B\n";
      await expectRemote(remote, { "Note.md": merged });
      await expectLocal(b, { "Note.md": merged });
      await step("A syncs again", () => a.sync());
      await expectInSync(remote, [a, b]);
    },
  }),
];
