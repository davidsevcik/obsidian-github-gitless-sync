/**
 * Drives the window of a vault like a user would: real mouse clicks at the
 * position of elements on the screen of the VM, and screenshots.
 *
 * Elements are found through the DOM, by their text or label, then clicked
 * with peekaboo at their center. A click fails if something else covers the
 * element there, so a broken layout fails the scenario as it would stop the
 * user.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { sleep, sshExec, waitFor } from "./vm";

export type Evaluate = <T>(body: string, args?: unknown) => Promise<T>;

// Every window gets the same place and size, so screenshots compare
export const WINDOW_SIZE = { width: 1280, height: 800 };
const WINDOW_ORIGIN = { x: 0, y: 30 };
// Narrower windows get the layout of a phone
export const NARROW_WIDTH = 600;

// Root of the conflicts view, menus and modals are on top of it
export const VIEW = '.workspace-leaf-content[data-type="conflicts-resolution-view"]';

/**
 * Where screenshots go, set by the runner for each scenario. Null skips them.
 */
export const screenshots = { dir: null as string | null };

// Screenshots named with it are copied to assets/ by e2e/readme-screenshots.ts
export const README_PREFIX = "readme-";

export interface Target {
  // Exact text of the element, or its aria-label
  text: string;
  // CSS selector the element must be in. By default the topmost layer: an
  // open menu, else an open modal, else the conflicts view
  within?: string;
  // Which one, if several elements match. Without it a match must be unique
  nth?: number;
}

type Point = { x: number; y: number };

// Code shared by the functions running in the window
const HELPERS = `
  const VIEW = ${JSON.stringify(VIEW)};
  const remote = window.require("@electron/remote");
  const win = remote.getCurrentWindow();
  const visible = (el) => el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== "hidden";
  const layer = (within) => {
    if (within) return document.querySelector(within);
    return [".menu", ".modal-container", VIEW]
      .map((s) => [...document.querySelectorAll(s)].filter(visible).at(-1))
      .find(Boolean) ?? null;
  };
  // The text as shown, SVG elements have no innerText
  const ownText = (el) => (el.innerText ?? el.textContent ?? "").replace(/\\s+/g, " ").trim();
  // Elements with the text, the innermost ones, as a parent shares the text
  // of an only child
  const find = ({ text, within }) => {
    const root = layer(within);
    if (!root) return [];
    const all = [...root.querySelectorAll("*")].filter(
      (el) => visible(el) && (ownText(el) === text || el.getAttribute("aria-label") === text),
    );
    return all.filter((el) => !all.some((other) => other !== el && el.contains(other)));
  };
`;

export class AppWindow {
  constructor(
    private readonly vault: string,
    private readonly evaluate: Evaluate,
  ) {}

  /**
   * Brings the window to the front, at the standard place and size unless
   * given another size. A window narrower than NARROW_WIDTH is laid out like
   * a phone, without the file sidebar.
   */
  async focus(size = WINDOW_SIZE) {
    await this.evaluate(
      `${HELPERS}
       win.setBounds({ ...args.origin, ...args.size });
       const sidebar = app.workspace.leftSplit;
       if (args.size.width < args.narrowWidth) sidebar.collapse();
       else sidebar.expand();
       app.workspace.rightSplit.collapse();
       win.show();
       win.focus();
       remote.app.focus({ steal: true });
       for (let i = 0; i < 50 && !(win.isFocused() && document.hasFocus()); i++) {
         await sleep(100);
       }
       if (!win.isFocused()) throw new Error("The window didn't get the focus");
       // Lets the layout follow the new size
       await sleep(300);`,
      { origin: WINDOW_ORIGIN, size, narrowWidth: NARROW_WIDTH },
    );
  }

  /**
   * Waits for the conflicts view to show, with a file to resolve.
   */
  async waitForConflictsView() {
    await waitFor(
      `the conflicts view to open in ${this.vault}`,
      () =>
        this.evaluate<boolean>(
          `${HELPERS}
           const view = document.querySelector(VIEW);
           return !!view && visible(view) &&
             !!view.querySelector(".conflicts-accept-all-bar");`,
        ),
      60_000,
      1000,
    );
  }

  async waitForText(text: string, within?: string, timeoutMs = 15_000) {
    await waitFor(
      `"${text}" to show in ${this.vault}`,
      async () => (await this.count({ text, within })) > 0,
      timeoutMs,
    );
  }

  /**
   * How many visible elements have the text.
   */
  async count(target: Target): Promise<number> {
    return this.evaluate<number>(`${HELPERS} return find(args).length;`, target);
  }

  /**
   * Visible text of each element matching the selector, in the conflicts
   * view by default.
   */
  async texts(selector: string, within = VIEW): Promise<string[]> {
    return this.evaluate<string[]>(
      `${HELPERS}
       const root = document.querySelector(args.within);
       if (!root) return [];
       return [...root.querySelectorAll(args.selector)].filter(visible).map(ownText);`,
      { selector, within },
    );
  }

  /**
   * Bounding boxes of the visible elements matching the selector, relative
   * to the window.
   */
  async boxes(
    selector: string,
  ): Promise<{ x: number; y: number; width: number; height: number }[]> {
    return this.evaluate(
      `${HELPERS}
       return [...document.querySelectorAll(args)].filter(visible).map((el) => {
         const r = el.getBoundingClientRect();
         return { x: r.left, y: r.top, width: r.width, height: r.height };
       });`,
      selector,
    );
  }

  /**
   * Runs code in the window to check something the other methods don't,
   * `view` is the root element of the conflicts view.
   */
  async inspect<T>(body: string, args: unknown = null): Promise<T> {
    return this.evaluate<T>(
      `${HELPERS}
       const view = document.querySelector(VIEW);
       const inner = async (args) => {\n${body}\n};
       return inner(args);`,
      args,
    );
  }

  /**
   * Clicks the element with the mouse, at its center.
   */
  async click(target: Target | string) {
    const t = typeof target === "string" ? { text: target } : target;
    const point = await this.locate(t);
    const res = await sshExec(`peekaboo click --at ${point.x},${point.y} --foreground`);
    if (res.code !== 0) {
      throw new Error(`Click on "${t.text}" failed: ${res.stderr.trim() || res.stdout.trim()}`);
    }
    // React renders and Obsidian animates menus and modals
    await sleep(400);
  }

  /**
   * Screen position of the element's center, after scrolling it into view.
   * Fails if the element isn't the one the mouse would hit there.
   */
  private async locate(target: Target): Promise<Point> {
    await this.focus(await this.size());
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        return await this.evaluate<Point>(
          `${HELPERS}
           const found = find(args);
           const what = JSON.stringify(args.text);
           if (found.length === 0) throw new Error("Nothing shows " + what);
           if (args.nth === undefined && found.length > 1) {
             throw new Error(found.length + " elements show " + what + ", pick one with nth");
           }
           const el = found[args.nth ?? 0];
           if (!el) throw new Error("No element " + args.nth + " shows " + what);
           el.scrollIntoView({ block: "center", inline: "center" });
           await sleep(100);
           const r = el.getBoundingClientRect();
           const x = r.left + r.width / 2;
           const y = r.top + r.height / 2;
           const hit = document.elementFromPoint(x, y);
           if (!hit || !(el === hit || el.contains(hit))) {
             const by = hit ? hit.tagName.toLowerCase() + "." + [...hit.classList].join(".") : "nothing";
             throw new Error(what + " is covered by " + by);
           }
           const b = win.getContentBounds();
           return { x: Math.round(b.x + x), y: Math.round(b.y + y) };`,
          target,
        );
      } catch (err) {
        // Wait for animations, renders and transitions to end
        lastError = err;
        await sleep(300);
      }
    }
    throw lastError;
  }

  private async size(): Promise<{ width: number; height: number }> {
    return this.evaluate(
      `${HELPERS} const b = win.getContentBounds(); return { width: b.width, height: b.height };`,
    );
  }

  /**
   * Saves a screenshot of the window, if the runner asked for screenshots.
   * Returns where it's saved.
   * @param options.of Selector of the element to crop the screenshot to
   * @param options.clean Removes notices and tooltips first, for the README
   */
  async screenshot(
    name: string,
    options: { of?: string; clean?: boolean } = {},
  ): Promise<string | null> {
    if (!screenshots.dir) {
      return null;
    }
    await this.focus(await this.size());
    const bounds = await this.evaluate<{ x: number; y: number; width: number; height: number }>(
      `${HELPERS}
       if (args.clean) {
         document.querySelectorAll(".notice, .tooltip").forEach((el) => el.remove());
       }
       const b = win.getContentBounds();
       if (!args.of) return b;
       const el = document.querySelector(args.of);
       if (!el) throw new Error("Nothing to crop the screenshot to: " + args.of);
       const r = el.getBoundingClientRect();
       return { x: Math.round(b.x + r.left), y: Math.round(b.y + r.top),
                width: Math.round(r.width), height: Math.round(r.height) };`,
      options,
    );
    const remotePath = `/tmp/e2e-screenshot-${process.pid}.png`;
    const res = await sshExec(
      `screencapture -x -R${bounds.x},${bounds.y},${bounds.width},${bounds.height} ${remotePath}` +
        ` && base64 -i ${remotePath} && rm -f ${remotePath}`,
    );
    if (res.code !== 0) {
      throw new Error(`Screenshot failed: ${res.stderr.trim()}`);
    }
    mkdirSync(screenshots.dir, { recursive: true });
    const file = path.join(screenshots.dir, `${this.vault}-${name}.png`);
    writeFileSync(file, Buffer.from(res.stdout.replace(/\s/g, ""), "base64"));
    return file;
  }

  /**
   * Saves a screenshot of the main area of the window for the README, see
   * e2e/readme-screenshots.ts. Name it like the file in assets/, without
   * the .png.
   */
  async readmeScreenshot(asset: string): Promise<string | null> {
    return this.screenshot(`${README_PREFIX}${asset}`, {
      of: ".workspace-split.mod-root",
      clean: true,
    });
  }
}
