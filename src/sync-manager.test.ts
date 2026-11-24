import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
// The mock vault reads and writes a real folder
import { Vault } from "../mock-obsidian";
import SyncManager, {
  ConflictResolution,
  conflictActionsFor,
} from "./sync-manager";
import Logger from "./logger";
import { DEFAULT_SETTINGS } from "./settings/settings";
import { MANIFEST_FILE_NAME } from "./metadata-store";
import { NewTreeRequestItem } from "./github/client";
import { calculateBlobSHA } from "./utils";

const MANIFEST = `.obsidian/${MANIFEST_FILE_NAME}`;

let vaultDir: string;

beforeEach(() => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-manager-test-"));
});

afterEach(() => {
  fs.rmSync(vaultDir, { recursive: true, force: true });
});

/// A sync manager on a vault in a temporary folder, the GitHub client
/// records what would be uploaded instead
const createSyncManager = (
  localFiles: Record<string, string | Uint8Array>,
  // The remote blobs by SHA
  remoteBlobs: Record<string, string | Uint8Array> = {},
) => {
  const vault = new Vault(vaultDir);
  for (const [filePath, content] of Object.entries(localFiles)) {
    fs.writeFileSync(path.join(vaultDir, filePath), content);
  }
  const manager = new SyncManager(
    vault as any,
    { ...DEFAULT_SETTINGS, githubOwner: "o", githubRepo: "r" },
    async () => [],
    new Logger(vault as any, false),
  );
  const uploaded = {
    tree: [] as NewTreeRequestItem[],
    blobs: [] as string[],
  };
  const internals = manager as any;
  internals.client = {
    getBlob: vi.fn(async ({ sha }: { sha: string }) => ({
      content: Buffer.from(remoteBlobs[sha]).toString("base64"),
    })),
    createBlob: vi.fn(async ({ content }: { content: string }) => {
      uploaded.blobs.push(Buffer.from(content, "base64").toString());
      return { sha: `blob-${uploaded.blobs.length}` };
    }),
    createTree: vi.fn(
      async ({ tree }: { tree: { tree: NewTreeRequestItem[] } }) => {
        uploaded.tree = tree.tree;
        return "tree-sha";
      },
    ),
    createCommit: vi.fn(async () => "commit-sha"),
    updateBranchHead: vi.fn(async () => {}),
  };
  internals.metadataStore.data = {
    lastSync: 0,
    files: Object.fromEntries(
      Object.keys(localFiles).map((filePath) => [
        filePath,
        {
          path: filePath,
          sha: "old-sha",
          dirty: true,
          justDownloaded: false,
          lastModified: 0,
        },
      ]),
    ),
  };
  internals.metadataStore.save = async () => {};
  return { manager, uploaded, metadata: () => internals.metadataStore.data };
};

const treeFile = (filePath: string, content: string): NewTreeRequestItem => ({
  path: filePath,
  mode: "100644",
  type: "blob",
  content,
});

const commit = async (
  manager: SyncManager,
  files: Record<string, string>,
  resolutions: ConflictResolution[],
) => {
  const treeFiles: Record<string, NewTreeRequestItem> = {
    [MANIFEST]: { path: MANIFEST, mode: "100644", type: "blob", sha: "x" },
  };
  for (const [filePath, content] of Object.entries(files)) {
    treeFiles[filePath] = treeFile(filePath, content);
  }
  await manager.commitSync(
    treeFiles,
    "base-tree",
    { added: [], updated: Object.keys(files), deleted: [] },
    resolutions,
  );
};

describe("uploadContent", () => {
  it("uploads an empty conflict resolution, not the local file", async () => {
    const { manager } = createSyncManager({ "note.md": "draft" });
    expect(
      await manager.uploadContent("note.md", [
        { filePath: "note.md", content: "" },
      ]),
    ).toBe("");
  });

  it("uploads the local file if there was no conflict", async () => {
    const { manager } = createSyncManager({ "note.md": "draft" });
    expect(await manager.uploadContent("note.md", [])).toBe("draft");
  });
});

describe("commitSync", () => {
  it("tracks the SHA of an empty conflict resolution", async () => {
    const { manager, metadata } = createSyncManager({ "note.md": "draft" });
    await commit(manager, { "note.md": "" }, [
      { filePath: "note.md", content: "" },
    ]);
    expect(metadata().files["note.md"].sha).toBe(
      await calculateBlobSHA(new Uint8Array()),
    );
    expect(fs.readFileSync(path.join(vaultDir, "note.md"), "utf8")).toBe("");
  });

  it("uploads the resolution of a non-text file, not the local file", async () => {
    const { manager, uploaded } = createSyncManager({
      "diagram.svg": "<svg>local</svg>",
    });
    await commit(manager, { "diagram.svg": "<svg>remote</svg>" }, [
      { filePath: "diagram.svg", content: "<svg>remote</svg>" },
    ]);
    expect(uploaded.blobs).toEqual(["<svg>remote</svg>"]);
    expect(uploaded.tree.find((f) => f.path === "diagram.svg")?.sha).toBe(
      "blob-1",
    );
    expect(fs.readFileSync(path.join(vaultDir, "diagram.svg"), "utf8")).toBe(
      "<svg>remote</svg>",
    );
  });

  it("uploads the local content of a non-text file without conflicts", async () => {
    const { manager, uploaded } = createSyncManager({
      "diagram.svg": "<svg>local</svg>",
    });
    await commit(manager, { "diagram.svg": "<svg>local</svg>" }, []);
    expect(uploaded.blobs).toEqual(["<svg>local</svg>"]);
  });
});

describe("loadConflictFile", () => {
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0,
  ]);

  it("loads both versions of a text file", async () => {
    const { manager } = createSyncManager(
      { "drawing.svg": "<svg>local</svg>" },
      { "remote-sha": "<svg>remote</svg>" },
    );
    expect(await manager.loadConflictFile("drawing.svg", "remote-sha")).toEqual(
      {
        filePath: "drawing.svg",
        remoteContent: "<svg>remote</svg>",
        localContent: "<svg>local</svg>",
        binary: false,
      },
    );
  });

  it("doesn't decode a binary file", async () => {
    const { manager } = createSyncManager(
      { "image.png": png },
      { "remote-sha": png.slice(0, 9) },
    );
    const file = await manager.loadConflictFile("image.png", "remote-sha");
    expect(file).toMatchObject({
      filePath: "image.png",
      remoteContent: "",
      localContent: "",
      binary: true,
    });
    // Kept to preview them
    expect(new Uint8Array(file.remoteBytes!)).toEqual(png.slice(0, 9));
    expect(new Uint8Array(file.localBytes!)).toEqual(png);
  });

  it("can't merge a file that is binary on one side only", async () => {
    const { manager } = createSyncManager(
      { "notes.md": "text" },
      { "remote-sha": png },
    );
    expect(
      (await manager.loadConflictFile("notes.md", "remote-sha")).binary,
    ).toBe(true);
  });
});

describe("conflictActionsFor", () => {
  it("uploads merged files and writes them after the sync", () => {
    expect(
      conflictActionsFor([{ filePath: "note.md", content: "merged" }]),
    ).toEqual({
      actions: [{ type: "upload", filePath: "note.md" }],
      resolutions: [{ filePath: "note.md", content: "merged" }],
    });
  });

  it("replaces the other version of a file kept whole", () => {
    expect(
      conflictActionsFor([
        { filePath: "remote.png", keep: "remote" },
        { filePath: "local.png", keep: "local" },
      ]),
    ).toEqual({
      actions: [
        { type: "download", filePath: "remote.png" },
        { type: "upload", filePath: "local.png" },
      ],
      resolutions: [],
    });
  });
});
