// The conflicts view, used with the mouse like the user would: the sync
// opens the real view and the scenario clicks its buttons in the window.
// Each scenario saves screenshots of the view, some of them for the README,
// see e2e/README.md.
import { BROKEN_IMAGE, DAY_PNG, PNG, SUNSET_PNG } from "../lib/fixtures";
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

// A note both devices edit. A, whose version is the remote one once it
// synced, moved the flight and the stay. B, the local one, picked a seat
// and added a to-do.
const TRIP = {
  seed: `# Trip to Lisbon

## Flights
- Outbound: Friday 7:40, gate closes 7:10
- Return: Monday 19:05

## Stay
Hotel in Alfama, check-in from 15:00.

## To do
- Book the tram 28 tour
- Buy the Lisboa card
- Dinner reservation
`,
  a: `# Trip to Lisbon

## Flights
- Outbound: Friday 9:15, gate closes 8:45
- Return: Monday 19:05

## Stay
Apartment in Bairro Alto, keys at the café downstairs.

## To do
- Book the tram 28 tour
- Buy the Lisboa card
- Dinner reservation
`,
  b: `# Trip to Lisbon

## Flights
- Outbound: Friday 7:40, seat 14C
- Return: Monday 19:05

## Stay
Hotel in Alfama, check-in from 15:00.

## To do
- Book the tram 28 tour
- Buy the Lisboa card
- Dinner reservation
- Pack the travel adapter
`,
};

const PACKING = {
  seed: "- Passport\n- Charger\n- Sunglasses\n",
  a: "- Passport\n- Charger\n- Sunglasses\n- Hat\n",
  b: "- Passport\n- Phone charger\n- Sunglasses\n",
};

// The near hill of the photos: green by day, purple at sunset
const DAY_HILL = [60, 120, 70];
const SUNSET_HILL = [60, 40, 60];

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
 * What the versions of the open binary file show: their titles, the color
 * of the near hill in the image they show, null for no image or one that
 * didn't load, and their texts.
 */
function binaryVersions(b: Device) {
  return b.window.inspect<
    { title: string; hill: number[] | null; text: string }[]
  >(
    `// Images load asynchronously
     for (let i = 0; i < 20; i++) {
       const images = [...view.querySelectorAll(".conflicts-binary-image")].filter(visible);
       if (images.every((img) => img.complete)) break;
       await sleep(100);
     }
     const hill = (img) => {
       if (!img || !img.complete || img.naturalWidth === 0) return null;
       const canvas = document.createElement("canvas");
       canvas.width = img.naturalWidth;
       canvas.height = img.naturalHeight;
       const context = canvas.getContext("2d");
       context.drawImage(img, 0, 0);
       return [...context.getImageData(180, 235, 1, 1).data.slice(0, 3)];
     };
     return [...view.querySelectorAll(".conflicts-binary-version")].filter(visible).map((el) => ({
       title: ownText(el.querySelector(".conflicts-pane-header")),
       hill: hill(el.querySelector("img")),
       text: ownText(el),
     }));`,
  );
}

export default [
  scenario({
    name: "binary image conflict previews both versions and keeps the remote one",
    tags,
    devices,
    seed: { "README.md": "# Readme\n", "Photos/Lake.png": PNG },
    async run({ a, b, remote, step }) {
      const pending = await conflict(a, b, step, {
        "Photos/Lake.png": { a: DAY_PNG, b: SUNSET_PNG },
      });
      await step("the view previews both images side by side", async () => {
        const versions = await binaryVersions(b);
        expectEqual(
          versions.map((v) => [v.title, v.hill, v.text.includes("2.3 KB")]),
          [
            ["Remote", DAY_HILL, true],
            ["Local", SUNSET_HILL, true],
          ],
          "versions",
        );
        const [remoteBox, localBox] = await b.window.boxes(".conflicts-binary-version");
        expectEqual(
          { sameRow: Math.abs(remoteBox.y - localBox.y) < 2, remoteFirst: remoteBox.x < localBox.x },
          { sameRow: true, remoteFirst: true },
          "layout of the versions",
        );
        await b.window.screenshot("binary-image");
        await b.window.readmeScreenshot("binary_conflict");
      });
      await step("B keeps the remote version", () => b.window.click("Keep remote"));
      const result = await step("the sync ends", () => pending.result());
      expectEqual(result.conflicts, ["Photos/Lake.png"], "conflicts");
      await b.window.waitForText("No conflicts to resolve");
      await expectRemote(remote, { "Photos/Lake.png": DAY_PNG });
      await expectLocal(b, { "Photos/Lake.png": DAY_PNG });
      await expectInSync(remote, [a, b]);
    },
  }),

  scenario({
    name: "binary image versions stack in a narrow window",
    tags,
    devices,
    seed: { "README.md": "# Readme\n", "Photos/Lake.png": PNG },
    async run({ a, b, remote, step }) {
      const pending = await conflict(a, b, step, {
        "Photos/Lake.png": { a: DAY_PNG, b: SUNSET_PNG },
      });
      await step("B's window gets as narrow as a phone", async () => {
        await b.window.focus({ width: 420, height: 800 });
        const [view] = await b.window.boxes(VIEW);
        expectEqual(view.width < 420 && view.width > 300, true, `width of the view, ${view.width}`);
      });
      await step("the versions stack, remote first", async () => {
        const versions = await binaryVersions(b);
        expectEqual(
          versions.map((v) => [v.title, v.hill]),
          [
            ["Remote", DAY_HILL],
            ["Local", SUNSET_HILL],
          ],
          "versions",
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
      await expectRemote(remote, { "Photos/Lake.png": SUNSET_PNG });
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
          await b.window.texts(".conflicts-file-count"),
          ["Binary file", "Binary file"],
          "file rows",
        );
        expectEqual(
          await b.window.texts(".conflicts-accept-all-count"),
          ["2 files with conflicts"],
          "count",
        );
        await b.window.screenshot("unified-list");
      });
      await step("B opens broken.png", () => b.window.click("broken.png"));
      await step("the image versions say they can't be shown", async () => {
        const versions = await binaryVersions(b);
        expectEqual(
          versions.map((v) => [v.title, v.hill, v.text.includes("Can't show this image")]),
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
          versions.map((v) => [v.title, v.hill, v.text]),
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
    seed: {
      "README.md": "# Readme\n",
      "Trip to Lisbon.md": TRIP.seed,
      "Photos/Lake.png": PNG,
    },
    async run({ a, b, remote, step }) {
      const pending = await conflict(a, b, step, {
        "Trip to Lisbon.md": TRIP,
        "Photos/Lake.png": { a: DAY_PNG, b: SUNSET_PNG },
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
      expectEqual(
        [...result.conflicts].sort(),
        ["Photos/Lake.png", "Trip to Lisbon.md"],
        "conflicts",
      );
      await expectRemote(remote, {
        "Trip to Lisbon.md": TRIP.b,
        "Photos/Lake.png": SUNSET_PNG,
      });
      await step("A syncs again", () => a.sync());
      await expectInSync(remote, [a, b]);
    },
  }),

  scenario({
    name: "split view resolves a text conflict with the gutter buttons",
    tags,
    devices,
    seed: { "README.md": "# Readme\n", "Trip to Lisbon.md": TRIP.seed },
    async run({ a, b, remote, step }) {
      const pending = await conflict(a, b, step, { "Trip to Lisbon.md": TRIP });
      await step("the view shows both versions", async () => {
        await b.window.waitForText("Resolve conflict");
        const disabled = await b.window.inspect<boolean>(
          `return find({ text: "Resolve conflict" })[0].disabled;`,
        );
        expectEqual(disabled, true, "Resolve conflict disabled with conflicts left");
        await b.window.screenshot("split-text");
        await b.window.readmeScreenshot("split_diff_view");
      });
      await step("B takes the remote flight and stay, and its own to-do", async () => {
        await b.window.click({ text: "Use remote lines", nth: 0 });
        await b.window.click({ text: "Use remote lines", nth: 0 });
        await b.window.click("Use local lines");
        await b.window.screenshot("split-text-resolved");
      });
      await step("B resolves the file", () => b.window.click("Resolve conflict"));
      await step("the sync ends", () => pending.result());
      const merged = TRIP.a.replace(
        "- Dinner reservation\n",
        "- Dinner reservation\n- Pack the travel adapter\n",
      );
      await expectRemote(remote, { "Trip to Lisbon.md": merged });
      await expectLocal(b, { "Trip to Lisbon.md": merged });
      await step("A syncs again", () => a.sync());
      await expectInSync(remote, [a, b]);
    },
  }),

  scenario({
    name: "unified view resolves each conflict of each text file",
    tags,
    devices,
    settings: { conflictViewMode: "unified" },
    seed: {
      "README.md": "# Readme\n",
      "Trip to Lisbon.md": TRIP.seed,
      "Packing list.md": PACKING.seed,
    },
    async run({ a, b, remote, step }) {
      const pending = await conflict(a, b, step, {
        "Trip to Lisbon.md": TRIP,
        "Packing list.md": PACKING,
      });
      await step("the list counts the conflicts of each file", async () => {
        const rows = await b.window.texts(".conflicts-file-row");
        expectEqual(
          rows.sort(),
          ["Packing list.md 2 conflicts", "Trip to Lisbon.md 3 conflicts"],
          "rows",
        );
        await b.window.screenshot("unified-list");
        await b.window.readmeScreenshot("unified_file_list");
      });
      await step("B opens Trip to Lisbon.md", () => b.window.click("Trip to Lisbon.md"));
      await step("the file shows its three conflicts", async () => {
        await b.window.waitForText("3 conflicts left");
        await b.window.screenshot("unified-text");
        await b.window.readmeScreenshot("unified_diff_view");
      });
      await step("B keeps its seat, the remote stay and its to-do", async () => {
        await b.window.click({ text: "Accept local", nth: 0 });
        await b.window.waitForText("2 conflicts left");
        await b.window.click({ text: "Accept remote", nth: 0 });
        await b.window.waitForText("1 conflict left");
        await b.window.click({ text: "Accept local", nth: 0 });
        await b.window.waitForText("No conflicts left");
        await b.window.screenshot("unified-text-resolved");
      });
      await step("B resolves the file", () => b.window.click("Resolve conflict"));
      await step("B takes the remote packing list", async () => {
        if ((await b.window.count({ text: "Packing list.md", within: ".conflicts-file-screen" })) === 0) {
          // The list comes back if the file was the last one in it
          await b.window.click("Packing list.md");
        }
        await b.window.click("All remote");
        await b.window.click("Resolve conflict");
      });
      await step("the sync ends", () => pending.result());
      const trip = TRIP.b.replace(
        "Hotel in Alfama, check-in from 15:00.",
        "Apartment in Bairro Alto, keys at the café downstairs.",
      );
      await expectRemote(remote, { "Trip to Lisbon.md": trip, "Packing list.md": PACKING.a });
      await expectLocal(b, { "Trip to Lisbon.md": trip, "Packing list.md": PACKING.a });
      await step("A syncs again", () => a.sync());
      await expectInSync(remote, [a, b]);
    },
  }),
];
