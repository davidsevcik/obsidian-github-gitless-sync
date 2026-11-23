import { config, githubToken } from "./config";
import { isVisible } from "./obsidian";

const MANIFEST_PATH = ".obsidian/github-sync-metadata.json";

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.github.com/repos/${config.repo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${githubToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gitless-sync-e2e",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `GitHub ${method} ${path} failed: ${res.status} ${await res.text()}`,
    );
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

type Content = string | Uint8Array;

interface TreeEntry {
  path: string;
  mode: "100644";
  type: "blob";
  sha: string | null;
}

async function treeEntries(files: Record<string, Content>): Promise<TreeEntry[]> {
  return Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      // Blobs keep binary content intact, unlike content in a tree
      const { sha } = await api<{ sha: string }>("POST", "/git/blobs", {
        content: Buffer.from(content).toString("base64"),
        encoding: "base64",
      });
      return { path, mode: "100644" as const, type: "blob" as const, sha };
    }),
  );
}

/**
 * The branch of the test repository a scenario syncs with.
 * Changes made with it are made outside of the plugin, like with git or on
 * the GitHub website.
 */
export class Remote {
  private constructor(readonly branch: string) {}

  /**
   * Creates the branch with a single commit, unrelated to any other branch.
   */
  static async create(
    branch: string,
    files: Record<string, Content>,
  ): Promise<Remote> {
    const tree = await api<{ sha: string }>("POST", "/git/trees", {
      tree: await treeEntries(files),
    });
    const commit = await api<{ sha: string }>("POST", "/git/commits", {
      message: "ext: E2E seed",
      tree: tree.sha,
      parents: [],
    });
    await api("POST", "/git/refs", {
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    });
    return new Remote(branch);
  }

  /**
   * Deletes all the branches whose name starts with the prefix.
   * @returns the names of the deleted branches
   */
  static async deleteAll(prefix: string): Promise<string[]> {
    const refs = await api<{ ref: string }[]>(
      "GET",
      `/git/matching-refs/heads/${prefix}`,
    );
    const branches = refs.map((r) => r.ref.replace(/^refs\/heads\//, ""));
    for (const branch of branches) {
      await new Remote(branch).delete();
    }
    return branches;
  }

  async delete() {
    await api("DELETE", `/git/refs/heads/${this.branch}`);
  }

  async head(): Promise<string> {
    const ref = await api<{ object: { sha: string } }>(
      "GET",
      `/git/ref/heads/${this.branch}`,
    );
    return ref.object.sha;
  }

  /**
   * Git SHAs of the files in the branch by path.
   * @param all Include hidden files and the config dir too
   */
  async files(all = false): Promise<Record<string, string>> {
    const commit = await api<{ tree: { sha: string } }>(
      "GET",
      `/git/commits/${await this.head()}`,
    );
    const { tree } = await api<{
      tree: { path: string; type: string; sha: string }[];
    }>("GET", `/git/trees/${commit.tree.sha}?recursive=1`);
    return Object.fromEntries(
      tree
        .filter((e) => e.type === "blob" && (all || isVisible(e.path)))
        .map((e) => [e.path, e.sha]),
    );
  }

  async readBytes(path: string): Promise<Buffer | null> {
    const sha = (await this.files(true))[path];
    if (sha === undefined) {
      return null;
    }
    const blob = await api<{ content: string }>("GET", `/git/blobs/${sha}`);
    return Buffer.from(blob.content, "base64");
  }

  async read(path: string): Promise<string | null> {
    return (await this.readBytes(path))?.toString("utf8") ?? null;
  }

  /**
   * Commits changes on top of the branch, outside of the plugin.
   */
  async commit(
    changes: { write?: Record<string, Content>; delete?: string[] },
    message = "ext: External change",
  ): Promise<string> {
    const parent = await this.head();
    const base = await api<{ tree: { sha: string } }>(
      "GET",
      `/git/commits/${parent}`,
    );
    const entries: TreeEntry[] = [
      ...(await treeEntries(changes.write ?? {})),
      ...(changes.delete ?? []).map((path) => ({
        path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: null,
      })),
    ];
    const tree = await api<{ sha: string }>("POST", "/git/trees", {
      base_tree: base.tree.sha,
      tree: entries,
    });
    const commit = await api<{ sha: string }>("POST", "/git/commits", {
      message,
      tree: tree.sha,
      parents: [parent],
    });
    await api("PATCH", `/git/refs/heads/${this.branch}`, { sha: commit.sha });
    return commit.sha;
  }

  /**
   * Messages of the last commits, newest first.
   */
  async commitMessages(count = 5): Promise<string[]> {
    const commits = await api<{ commit: { message: string } }[]>(
      "GET",
      `/commits?sha=${encodeURIComponent(this.branch)}&per_page=${count}`,
    );
    return commits.map((c) => c.commit.message);
  }

  /**
   * The plugin metadata stored in the branch.
   */
  async manifest(): Promise<{
    files: Record<string, { sha: string | null; deleted?: boolean | null }>;
  }> {
    const content = await this.read(MANIFEST_PATH);
    if (content === null) {
      throw new Error(`No manifest in ${this.branch}`);
    }
    return JSON.parse(content);
  }
}
