import {
  Vault,
  Notice,
  Platform,
  normalizePath,
  base64ToArrayBuffer,
  arrayBufferToBase64,
} from "obsidian";
import GithubClient, {
  GetTreeResponseItem,
  NewTreeRequestItem,
  RepoContent,
} from "./github/client";
import MetadataStore, {
  FileMetadata,
  Metadata,
  MANIFEST_FILE_NAME,
} from "./metadata-store";
import EventsListener from "./events-listener";
import { GitHubSyncSettings, PLUGIN_ID } from "./settings/settings";
import {
  CommitChanges,
  buildCommitMessage,
  buildSyncSummary,
} from "./commit-message";
import Logger, { LOG_FILE_NAME } from "./logger";
import { decodeBase64String, hasTextExtension } from "./utils";
import GitHubSyncPlugin from "./main";
import GitIgnore, { GITIGNORE_FILE_NAME } from "./gitignore";
import { BlobReader, Entry, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";

// Hidden folders that must never be synced.
// GitHub refuses any path containing .git, and .trash is where Obsidian
// moves deleted files, if the user chose so.
const UNSYNCABLE_FOLDERS = [".git", ".trash"];

// How long we keep track of a deleted file after it's gone from the remote too.
// It's only needed to decide what to do if the file has been deleted on a device
// and edited on another one, after this we fall back to comparing its content.
const DELETED_FILES_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface SyncAction {
  type: "upload" | "download" | "delete_local" | "delete_remote";
  filePath: string;
}

export interface ConflictFile {
  filePath: string;
  remoteContent: string;
  localContent: string;
}

export interface ConflictResolution {
  filePath: string;
  content: string;
}

type OnConflictsCallback = (
  conflicts: ConflictFile[],
) => Promise<ConflictResolution[]>;

export default class SyncManager {
  private metadataStore: MetadataStore;
  private client: GithubClient;
  private eventsListener: EventsListener;
  private gitignore: GitIgnore;
  private syncIntervalId: number | null = null;

  // Use to track if syncing is in progress, this ideally
  // prevents multiple syncs at the same time and creation
  // of messy conflicts.
  private syncing: boolean = false;

  // SHA of the branch head at the time we read the remote content in the
  // current sync. The sync commit must be its child, so if anything else
  // changes the remote in the meantime the sync fails instead of overwriting it.
  private remoteHeadSha: string = "";

  constructor(
    private vault: Vault,
    private settings: GitHubSyncSettings,
    private onConflicts: OnConflictsCallback,
    private logger: Logger,
  ) {
    this.metadataStore = new MetadataStore(this.vault);
    this.client = new GithubClient(this.settings, this.logger);
    this.gitignore = new GitIgnore(this.vault);
    this.eventsListener = new EventsListener(
      this.vault,
      this.metadataStore,
      this.settings,
      this.logger,
      this.gitignore,
    );
  }

  /**
   * Makes sure the metadata reflects the state of the local .gitignore file.
   * Obsidian doesn't send events for hidden files so we can't rely on the
   * events listener to know when it's created or deleted.
   * Changes to its content are found when syncing by comparing SHAs.
   */
  private async trackGitignore() {
    const exists = await this.vault.adapter.exists(GITIGNORE_FILE_NAME);
    const metadata = this.metadataStore.data.files[GITIGNORE_FILE_NAME];
    if (exists && (!metadata || metadata.deleted)) {
      this.metadataStore.data.files[GITIGNORE_FILE_NAME] = {
        path: GITIGNORE_FILE_NAME,
        sha: null,
        dirty: true,
        justDownloaded: false,
        lastModified: Date.now(),
      };
    } else if (!exists && metadata && !metadata.deleted) {
      metadata.deleted = true;
      metadata.deletedAt = Date.now();
    }
  }

  /**
   * Removes the ignored files from a list of files metadata.
   * Files that are not tracked are never uploaded, downloaded or deleted.
   */
  private removeIgnoredFiles(files: { [key: string]: FileMetadata }) {
    Object.keys(files)
      .filter((filePath: string) => this.gitignore.ignores(filePath))
      .forEach((filePath: string) => delete files[filePath]);
  }

  /**
   * Returns true if the file is in a hidden folder, meaning one whose name
   * starts with a dot, at any depth. The config dir is one of those.
   */
  private isInHiddenFolder(filePath: string): boolean {
    return filePath
      .split("/")
      .slice(0, -1)
      .some((segment: string) => segment.startsWith("."));
  }

  /**
   * Returns true if we must not look into the folder when searching
   * for changes in hidden folders.
   */
  private isExcludedFolder(folder: string): boolean {
    if (UNSYNCABLE_FOLDERS.includes(folder.split("/").last() as string)) {
      return true;
    }
    if (!this.settings.syncConfigDir && folder === this.vault.configDir) {
      // The user doesn't want to sync configs
      return true;
    }
    return this.gitignore.ignores(`${folder}/`);
  }

  /**
   * Returns true if the file in a hidden folder can be synced.
   * The manifest is not considered as it's handled on its own.
   */
  private isSyncableHiddenFolderFile(filePath: string): boolean {
    const configDir = this.vault.configDir;
    if (
      filePath === `${configDir}/${MANIFEST_FILE_NAME}` ||
      // Obsidian recommends not syncing the workspace files
      filePath === `${configDir}/workspace.json` ||
      filePath === `${configDir}/workspace-mobile.json` ||
      // The log file must never be synced
      filePath === `${configDir}/${LOG_FILE_NAME}`
    ) {
      return false;
    }
    if (filePath.split("/").last()?.startsWith(".")) {
      // Hidden files create issues with syncing
      return false;
    }
    return !this.gitignore.ignores(filePath);
  }

  /**
   * Makes sure the metadata reflects the files in hidden folders, the
   * config dir included if the user wants to sync it.
   * Obsidian doesn't send events for anything in there, so files that are
   * created or deleted, like when installing or uninstalling a plugin, would
   * go unnoticed if we didn't check those folders ourselves.
   * Changes to the content of the files are found when syncing by comparing SHAs.
   */
  private async trackHiddenFoldersChanges() {
    const configDir = this.vault.configDir;
    const metadataFiles = this.metadataStore.data.files;

    // Track new files, or files that have been created again after being deleted.
    // Hidden folders can be anywhere so we need to go through all the folders,
    // though we only care about the files in the hidden ones. We get events for
    // all the others.
    const folders = [this.vault.getRoot().path];
    while (folders.length > 0) {
      const folder = folders.pop() as string;
      const res = await this.vault.adapter.list(folder);
      folders.push(
        ...res.folders.filter((f: string) => !this.isExcludedFolder(f)),
      );
      for (const filePath of res.files) {
        if (
          !this.isInHiddenFolder(filePath) ||
          !this.isSyncableHiddenFolderFile(filePath)
        ) {
          continue;
        }
        const metadata = metadataFiles[filePath];
        if (!metadata || metadata.deleted) {
          await this.logger.info("Found new file in hidden folder", filePath);
          metadataFiles[filePath] = {
            path: filePath,
            sha: null,
            dirty: true,
            justDownloaded: false,
            lastModified: Date.now(),
          };
        }
      }
    }

    // Mark as deleted the tracked files that don't exist anymore
    await Promise.all(
      Object.keys(metadataFiles)
        .filter((filePath: string) => {
          if (
            metadataFiles[filePath].deleted ||
            filePath === `${configDir}/${MANIFEST_FILE_NAME}` ||
            !this.isInHiddenFolder(filePath)
          ) {
            return false;
          }
          // Leave alone the files in folders we don't look into
          const segments = filePath.split("/").slice(0, -1);
          return !segments.some((_: string, index: number) =>
            this.isExcludedFolder(segments.slice(0, index + 1).join("/")),
          );
        })
        .map(async (filePath: string) => {
          if (await this.vault.adapter.exists(filePath)) {
            return;
          }
          await this.logger.info("Found deleted file in hidden folder", filePath);
          metadataFiles[filePath].deleted = true;
          metadataFiles[filePath].deletedAt = Date.now();
        }),
    );
  }

  /**
   * Name used to identify this device in sync commits.
   * It's the one set by the user, or the platform name if there's none.
   */
  private deviceName(): string {
    const name = this.settings.deviceName?.trim();
    if (name) {
      return name;
    }
    if (Platform?.isIosApp) {
      return "iOS";
    } else if (Platform?.isAndroidApp) {
      return "Android";
    } else if (Platform?.isMacOS) {
      return "macOS";
    } else if (Platform?.isWin) {
      return "Windows";
    } else if (Platform?.isLinux) {
      return "Linux";
    }
    return "Obsidian";
  }

  /**
   * Identifies the remote repository and branch we're syncing with.
   */
  private remoteId(): string {
    return `${this.settings.githubOwner}/${this.settings.githubRepo}@${this.settings.githubBranch}`;
  }

  /**
   * Stops tracking the files that have been deleted long ago and are gone from
   * the remote repository too. If we didn't the metadata would grow forever.
   * Devices that still have those files find out they've been deleted because
   * they're not in the remote anymore, see determineSyncActions.
   *
   * @param remoteTree All files in the remote repository
   */
  private removeExpiredDeletedFiles(remoteTree: {
    [key: string]: GetTreeResponseItem;
  }) {
    const files = this.metadataStore.data.files;
    const now = Date.now();
    Object.keys(files)
      .filter((filePath: string) => {
        const file = files[filePath];
        return (
          file.deleted &&
          !remoteTree[filePath] &&
          now - (file.deletedAt ?? 0) > DELETED_FILES_RETENTION_MS
        );
      })
      .forEach((filePath: string) => delete files[filePath]);
  }

  /**
   * Returns true if a file in the remote tree is one we'd sync if it was in
   * the vault. Files this plugin never tracks, like hidden files, must not
   * be downloaded just because they're in the remote repository.
   */
  private isSyncableRemoteFile(filePath: string): boolean {
    if (filePath === GITIGNORE_FILE_NAME) {
      return true;
    }
    const folders = filePath.split("/").slice(0, -1);
    if (
      folders.some((_: string, index: number) =>
        this.isExcludedFolder(folders.slice(0, index + 1).join("/")),
      )
    ) {
      return false;
    }
    return (
      !this.isDeviceSpecificConfig(filePath) &&
      this.isSyncableHiddenFolderFile(filePath)
    );
  }

  /**
   * Updates the remote metadata with the changes made to the remote repository
   * by commits not made by this plugin, like the ones pushed with git, made on
   * the GitHub website or by GitHub Actions.
   * Those don't update the manifest, so it would still have the old SHA of the
   * files they changed, or not have the files they added at all, and we would
   * never download them. The remote tree is what's actually in the remote, so
   * when the two don't agree we trust the tree.
   *
   * @param remoteMetadata Metadata read from the remote manifest, it's updated in place
   * @param remoteTree All files in the remote repository
   */
  private async applyExternalChanges(
    remoteMetadata: Metadata,
    remoteTree: { [key: string]: GetTreeResponseItem },
  ) {
    const manifestPath = `${this.vault.configDir}/${MANIFEST_FILE_NAME}`;
    const changed: string[] = [];
    // We don't know when the change has been made, only that it's not older
    // than now. Using now means that if the file has been deleted locally
    // too, the remote change wins and the file is downloaded again, which is
    // better than losing it.
    const now = Date.now();
    Object.keys(remoteTree)
      .filter(
        (filePath: string) =>
          filePath !== manifestPath && this.isSyncableRemoteFile(filePath),
      )
      .forEach((filePath: string) => {
        const tracked = remoteMetadata.files[filePath];
        if (
          tracked &&
          !tracked.deleted &&
          tracked.sha === remoteTree[filePath].sha
        ) {
          return;
        }
        changed.push(filePath);
        remoteMetadata.files[filePath] = {
          path: filePath,
          sha: remoteTree[filePath].sha,
          dirty: false,
          justDownloaded: false,
          lastModified: now,
        };
      });

    const deleted: string[] = [];
    Object.keys(remoteMetadata.files)
      .filter(
        (filePath: string) =>
          filePath !== manifestPath &&
          !remoteMetadata.files[filePath].deleted &&
          !remoteTree[filePath],
      )
      .forEach((filePath: string) => {
        // The file has been deleted from the remote, or it has never got
        // there. Either way the manifest is wrong. Once it's gone from it
        // the file is handled like any other that is only in the vault: it's
        // deleted locally if it has been synced before and has not changed
        // since, otherwise it's uploaded.
        deleted.push(filePath);
        delete remoteMetadata.files[filePath];
      });

    if (changed.length > 0 || deleted.length > 0) {
      await this.logger.info("Found changes made outside of the plugin", {
        changed,
        deleted,
      });
    }
  }

  /**
   * Updates the local metadata with the changes we can't get events for and
   * loads the ignore rules.
   * Must be called before starting any sync.
   */
  private async refreshLocalMetadata() {
    await this.gitignore.load();
    await this.trackGitignore();
    await this.trackHiddenFoldersChanges();
    this.removeIgnoredFiles(this.metadataStore.data.files);
    await this.metadataStore.save();
  }

  /**
   * Returns true if the local vault root is empty.
   */
  private async vaultIsEmpty(): Promise<boolean> {
    const { files, folders } = await this.vault.adapter.list(
      this.vault.getRoot().path,
    );
    // There are files or folders in the vault dir
    return (
      files.length === 0 ||
      // We filter out the config dir since is always present so it's fine if we find it.
      folders.filter((f) => f !== this.vault.configDir).length === 0
    );
  }

  /**
   * Returns true if the file is in the config dir but is specific to this
   * device, so it must not be overwritten when downloading remote configs.
   */
  private isDeviceSpecificConfig(filePath: string): boolean {
    const configDir = this.vault.configDir;
    return [
      // Obsidian recommends not syncing the workspace files
      `${configDir}/workspace.json`,
      `${configDir}/workspace-mobile.json`,
      // Our own settings, they contain the token and the first sync state
      // the user just set on this device.
      `${configDir}/plugins/${PLUGIN_ID}/data.json`,
    ].includes(filePath);
  }

  /**
   * Handles first sync with remote and local.
   * This fails if neither remote nor local folders are empty.
   */
  async firstSync(): Promise<string | undefined> {
    if (this.syncing) {
      this.logger.info("First sync already in progress");
      // We're already syncing, nothing to do
      return;
    }

    this.syncing = true;
    let summary: string;
    try {
      summary = await this.firstSyncImpl();
    } catch (err) {
      this.syncing = false;
      throw err;
    }
    // We might have downloaded a new .gitignore
    await this.gitignore.load();
    this.syncing = false;
    return summary;
  }

  private async firstSyncImpl(): Promise<string> {
    await this.logger.info("Starting first sync");
    await this.refreshLocalMetadata();
    let repositoryIsEmpty = false;
    let res: RepoContent;
    let files: {
      [key: string]: GetTreeResponseItem;
    } = {};
    let treeSha: string = "";
    try {
      res = await this.client.getRepoContent();
      files = res.files;
      treeSha = res.sha;
      this.remoteHeadSha = res.headSha;
    } catch (err) {
      // 409 is returned in case the remote repo has been just created
      // and contains no files.
      // 404 instead is returned in case there are no files.
      // Either way we can handle both by commiting a new empty manifest.
      if (err.status !== 409 && err.status !== 404) {
        this.syncing = false;
        throw err;
      }
      // The repository is bare, meaning it has no tree, no commits and no branches
      repositoryIsEmpty = true;
    }

    if (repositoryIsEmpty) {
      await this.logger.info("Remote repository is empty");
      // Since the repository is completely empty we need to create a first commit.
      // We can't create that by going throught the normal sync process since the
      // API doesn't let us create a new tree when the repo is empty.
      // So we create a the manifest file as the first commit, since we're going
      // to create that in any case right after this.
      const buffer = await this.vault.adapter.readBinary(
        normalizePath(`${this.vault.configDir}/${MANIFEST_FILE_NAME}`),
      );
      await this.client.createFile({
        path: `${this.vault.configDir}/${MANIFEST_FILE_NAME}`,
        content: arrayBufferToBase64(buffer),
        message: "First sync",
        retry: true,
      });
      // Now get the repo content again cause we know for sure it will return a
      // valid sha that we can use to create the first sync commit.
      res = await this.client.getRepoContent({ retry: true });
      files = res.files;
      treeSha = res.sha;
      this.remoteHeadSha = res.headSha;
    }

    const vaultIsEmpty = await this.vaultIsEmpty();

    if (!repositoryIsEmpty && !vaultIsEmpty) {
      // Both have files, we can't sync, show error
      await this.logger.error("Both remote and local have files, can't sync");
      throw new Error("Both remote and local have files, can't sync");
    } else if (repositoryIsEmpty) {
      // Remote has no files and no manifest, let's just upload whatever we have locally.
      // This is fine even if the vault is empty.
      // The most important thing at this point is that the remote manifest is created.
      return await this.firstSyncFromLocal(files, treeSha);
    } else {
      // Local has no files and there's no manifest in the remote repo.
      // Let's download whatever we have in the remote repo.
      // This is fine even if the remote repo is empty.
      // In this case too the important step is that the remote manifest is created.
      return await this.firstSyncFromRemote(files, treeSha);
    }
  }

  /**
   * Handles first sync with the remote repository.
   * This must be called in case there are no files in the local content dir while
   * remote has files in the repo content dir but no manifest file.
   *
   * @param files All files in the remote repository, including those not in its content dir.
   * @param treeSha The SHA of the tree in the remote repository.
   */
  private async firstSyncFromRemote(
    files: { [key: string]: GetTreeResponseItem },
    treeSha: string,
  ): Promise<string> {
    await this.logger.info("Starting first sync from remote files");
    const downloaded: string[] = [];

    // We want to avoid getting throttled by GitHub, so instead of making a request for each
    // file we download the whole repository as a ZIP file and extract it in the vault.
    // We exclude config dir files if the user doesn't want to sync those.
    const zipBuffer = await this.client.downloadRepositoryArchive();
    const zipBlob = new Blob([zipBuffer]);
    const reader = new ZipReader(new BlobReader(zipBlob));
    const entries = await reader.getEntries();

    await this.logger.info("Extracting files from ZIP", {
      length: entries.length,
    });

    // The .gitignore in the remote repo is going to overwrite the local one,
    // if any, so its rules are the ones to follow from the start. If we don't
    // we would download files that must be ignored and upload local ones too.
    const gitignoreEntry = entries.find(
      (entry: Entry) =>
        !entry.directory &&
        entry.filename.split("/").slice(1).join("/") === GITIGNORE_FILE_NAME,
    );
    if (gitignoreEntry) {
      const writer = new Uint8ArrayWriter();
      await gitignoreEntry.getData!(writer);
      this.gitignore.setRules(new TextDecoder().decode(await writer.getData()));
      this.removeIgnoredFiles(this.metadataStore.data.files);
      await this.metadataStore.save();
    }

    await Promise.all(
      entries.map(async (entry: Entry) => {
        // All repo ZIPs contain a root directory that contains all the content
        // of that repo, we need to ignore that directory so we strip the first
        // folder segment from the path
        const pathParts = entry.filename.split("/");
        const targetPath =
          pathParts.length > 1 ? pathParts.slice(1).join("/") : entry.filename;

        if (targetPath === "") {
          // Must be the root folder, skip it.
          // This is really important as that would lead us to try and
          // create the folder "/" and crash Obsidian
          return;
        }

        if (
          !this.settings.syncConfigDir &&
          targetPath.startsWith(`${this.vault.configDir}/`) &&
          targetPath !== `${this.vault.configDir}/${MANIFEST_FILE_NAME}`
        ) {
          // The user doesn't want to sync configs, leave the local ones alone
          await this.logger.info("Skipped config", { targetPath });
          return;
        }

        if (this.isDeviceSpecificConfig(targetPath)) {
          // Even when syncing configs these files must stay as they are locally.
          // The local config dir is never empty, when it conflicts with the
          // remote one the remote wins for everything but these.
          await this.logger.info("Skipped device specific config", {
            targetPath,
          });
          return;
        }

        if (this.gitignore.ignores(targetPath)) {
          await this.logger.info("Skipped ignored file", { targetPath });
          return;
        }

        if (entry.directory) {
          const normalizedPath = normalizePath(targetPath);
          await this.vault.adapter.mkdir(normalizedPath);
          await this.logger.info("Created directory", {
            normalizedPath,
          });
          return;
        }

        if (targetPath === `${this.vault.configDir}/${LOG_FILE_NAME}`) {
          // We don't want to download the log file if the user synced it in the past.
          // This is necessary because in the past we forgot to ignore the log file
          // from syncing if the user enabled configs sync.
          // To avoid downloading it we ignore it if still present in the remote repo.
          return;
        }

        if (
          targetPath !== GITIGNORE_FILE_NAME &&
          targetPath.split("/").last()?.startsWith(".")
        ) {
          // We must skip hidden files as that creates issues with syncing.
          // This is fine as users can't edit hidden files in Obsidian anyway.
          // The .gitignore is the exception since we need its rules.
          await this.logger.info("Skipping hidden file", targetPath);
          return;
        }

        const writer = new Uint8ArrayWriter();
        await entry.getData!(writer);
        const data = await writer.getData();
        const dir = targetPath.split("/").splice(0, -1).join("/");
        if (dir !== "") {
          const normalizedDir = normalizePath(dir);
          await this.vault.adapter.mkdir(normalizedDir);
          await this.logger.info("Created directory", {
            normalizedDir,
          });
        }

        const normalizedPath = normalizePath(targetPath);
        await this.vault.adapter.writeBinary(normalizedPath, data);
        await this.logger.info("Written file", {
          normalizedPath,
        });
        downloaded.push(normalizedPath);
        this.metadataStore.data.files[normalizedPath] = {
          path: normalizedPath,
          sha: files[normalizedPath].sha,
          dirty: false,
          justDownloaded: true,
          lastModified: Date.now(),
        };
        await this.metadataStore.save();
      }),
    );

    await this.logger.info("Extracted zip");

    const newTreeFiles = Object.keys(files)
      .map((filePath: string) => ({
        path: files[filePath].path,
        mode: files[filePath].mode,
        type: files[filePath].type,
        sha: files[filePath].sha,
      }))
      .reduce(
        (
          acc: { [key: string]: NewTreeRequestItem },
          item: NewTreeRequestItem,
        ) => ({ ...acc, [item.path]: item }),
        {},
      );
    // Add files that are in the manifest but not in the tree.
    const added: string[] = [];
    await Promise.all(
      Object.keys(this.metadataStore.data.files)
        .filter((filePath: string) => {
          return !Object.keys(files).contains(filePath);
        })
        .map(async (filePath: string) => {
          added.push(filePath);
          const normalizedPath = normalizePath(filePath);
          // We need to check whether the file is a text file or not before
          // reading it here because trying to read a binary file as text fails
          // on iOS, and probably on other mobile devices too, so we read the file
          // content only if we're sure it contains text only.
          //
          // It's fine not reading the binary file in here and just setting some bogus
          // content because when committing the sync we're going to read the binary
          // file and upload its blob if it needs to be synced. The important thing is
          // that some content is set so we know the file changed locally and needs to be
          // uploaded.
          let content = "binaryfile";
          if (hasTextExtension(normalizedPath)) {
            content = await this.vault.adapter.read(normalizedPath);
          }
          newTreeFiles[filePath] = {
            path: filePath,
            mode: "100644",
            type: "blob",
            content,
          };
        }),
    );
    const sent = await this.commitSync(
      newTreeFiles,
      treeSha,
      { added, updated: [], deleted: [] },
      [],
      true,
    );
    const manifestPath = `${this.vault.configDir}/${MANIFEST_FILE_NAME}`;
    return buildSyncSummary(sent, {
      downloaded: downloaded.filter((filePath) => filePath !== manifestPath),
      deleted: [],
    });
  }

  /**
   * Handles first sync with the remote repository.
   * This must be called in case there are no files in the remote repo and no manifest while
   * local vault has files and a manifest.
   *
   * @param files All files in the remote repository
   * @param treeSha The SHA of the tree in the remote repository.
   */
  private async firstSyncFromLocal(
    files: { [key: string]: GetTreeResponseItem },
    treeSha: string,
  ): Promise<string> {
    await this.logger.info("Starting first sync from local files");
    const downloaded: string[] = [];
    const added: string[] = [];
    const newTreeFiles = Object.keys(files)
      .map((filePath: string) => ({
        path: files[filePath].path,
        mode: files[filePath].mode,
        type: files[filePath].type,
        sha: files[filePath].sha,
      }))
      .reduce(
        (
          acc: { [key: string]: NewTreeRequestItem },
          item: NewTreeRequestItem,
        ) => ({ ...acc, [item.path]: item }),
        {},
      );
    await Promise.all(
      Object.keys(this.metadataStore.data.files)
        .filter((filePath: string) => {
          // We should not try to sync deleted files, this can happen when
          // the user renames or deletes files after enabling the plugin but
          // before syncing for the first time
          return !this.metadataStore.data.files[filePath].deleted;
        })
        .map(async (filePath: string) => {
          added.push(filePath);
          const normalizedPath = normalizePath(filePath);
          // We need to check whether the file is a text file or not before
          // reading it here because trying to read a binary file as text fails
          // on iOS, and probably on other mobile devices too, so we read the file
          // content only if we're sure it contains text only.
          //
          // It's fine not reading the binary file in here and just setting some bogus
          // content because when committing the sync we're going to read the binary
          // file and upload its blob if it needs to be synced. The important thing is
          // that some content is set so we know the file changed locally and needs to be
          // uploaded.
          let content = "binaryfile";
          if (hasTextExtension(normalizedPath)) {
            content = await this.vault.adapter.read(normalizedPath);
          }
          newTreeFiles[filePath] = {
            path: filePath,
            mode: "100644",
            type: "blob",
            content,
          };
        }),
    );
    const sent = await this.commitSync(
      newTreeFiles,
      treeSha,
      { added, updated: [], deleted: [] },
      [],
      true,
    );
    const manifestPath = `${this.vault.configDir}/${MANIFEST_FILE_NAME}`;
    return buildSyncSummary(sent, {
      downloaded: downloaded.filter((filePath) => filePath !== manifestPath),
      deleted: [],
    });
  }

  /**
   * Syncs local and remote folders.
   * @returns
   */
  async sync() {
    if (this.syncing) {
      this.logger.info("Sync already in progress");
      // We're already syncing, nothing to do
      return;
    }

    const notice = new Notice("Syncing...");
    this.syncing = true;
    try {
      const summary = await this.syncImpl();
      // Shown only if sync doesn't fail
      new Notice(summary, 5000);
    } catch (err) {
      // Show the error to the user, it's not automatically dismissed to make sure
      // the user sees it.
      new Notice(`Error syncing. ${err}`);
    }
    // We might have downloaded a new .gitignore
    await this.gitignore.load();
    this.syncing = false;
    notice.hide();
  }

  private async syncImpl(): Promise<string> {
    await this.logger.info("Starting sync");
    await this.refreshLocalMetadata();
    const {
      files,
      sha: treeSha,
      headSha,
    } = await this.client.getRepoContent({
      retry: true,
    });
    this.remoteHeadSha = headSha;
    const manifest = files[`${this.vault.configDir}/${MANIFEST_FILE_NAME}`];

    if (manifest === undefined) {
      await this.logger.error("Remote manifest is missing", { files, treeSha });
      throw new Error("Remote manifest is missing");
    }

    if (
      Object.keys(files).contains(`${this.vault.configDir}/${LOG_FILE_NAME}`)
    ) {
      // We don't want to download the log file if the user synced it in the past.
      // This is necessary because in the past we forgot to ignore the log file
      // from syncing if the user enabled configs sync.
      // To avoid downloading it we delete it if still around.
      delete files[`${this.vault.configDir}/${LOG_FILE_NAME}`];
    }

    this.removeExpiredDeletedFiles(files);

    const blob = await this.client.getBlob({ sha: manifest.sha });
    const remoteMetadata: Metadata = JSON.parse(
      decodeBase64String(blob.content),
    );

    // Commits not made by this plugin don't update the manifest, so it might
    // not know about all the changes in the remote.
    await this.applyExternalChanges(remoteMetadata, files);
    // Ignored files that are still tracked remotely must be left alone
    this.removeIgnoredFiles(remoteMetadata.files);

    const conflicts = await this.findConflicts(remoteMetadata.files);

    // We treat every resolved conflict as an upload SyncAction, mainly cause
    // the user has complete freedom on the edits they can apply to the conflicting files.
    // So when a conflict is resolved we change the file locally and upload it.
    // That solves the conflict.
    let conflictActions: SyncAction[] = [];
    // We keep track of the conflict resolutions cause we want to update the file
    // locally only when we're sure the sync was successul. That happens after we
    // commit the sync.
    let conflictResolutions: ConflictResolution[] = [];

    if (conflicts.length > 0) {
      await this.logger.warn("Found conflicts", conflicts);
      if (this.settings.conflictHandling === "ask") {
        // Here we block the sync process until the user has resolved all the conflicts
        conflictResolutions = await this.onConflicts(conflicts);
        conflictActions = conflictResolutions.map(
          (resolution: ConflictResolution) => {
            return { type: "upload", filePath: resolution.filePath };
          },
        );
      } else if (this.settings.conflictHandling === "overwriteLocal") {
        // The user explicitly wants to always overwrite the local file
        // in case of conflicts so we just download the remote file to solve it

        // It's not necessary to set conflict resolutions as the content the
        // user expect must be the content of the remote file with no changes.
        conflictActions = conflictResolutions.map(
          (resolution: ConflictResolution) => {
            return { type: "download", filePath: resolution.filePath };
          },
        );
      } else if (this.settings.conflictHandling === "overwriteRemote") {
        // The user explicitly wants to always overwrite the remote file
        // in case of conflicts so we just upload the remote file to solve it.

        // It's not necessary to set conflict resolutions as the content the
        // user expect must be the content of the local file with no changes.
        conflictActions = conflictResolutions.map(
          (resolution: ConflictResolution) => {
            return { type: "upload", filePath: resolution.filePath };
          },
        );
      }
    }

    const determineActions = async (): Promise<SyncAction[]> => [
      ...(await this.determineSyncActions(
        remoteMetadata.files,
        this.metadataStore.data.files,
        conflictActions.map((action) => action.filePath),
        files,
      )),
      ...conflictActions,
    ];
    let actions = await determineActions();
    const gitignoreDownloaded: string[] = [];

    if (
      actions.some(
        (action) =>
          action.type === "download" && action.filePath === GITIGNORE_FILE_NAME,
      )
    ) {
      // The remote .gitignore is newer than ours. Its rules must be applied to
      // this same sync or we would upload and download files that must be ignored,
      // so we download it right away and determine the actions again.
      await this.downloadFile(
        files[GITIGNORE_FILE_NAME],
        remoteMetadata.files[GITIGNORE_FILE_NAME].lastModified,
      );
      gitignoreDownloaded.push(GITIGNORE_FILE_NAME);
      await this.gitignore.load();
      // Files the old rules ignored might not be ignored anymore
      await this.applyExternalChanges(remoteMetadata, files);
      this.removeIgnoredFiles(this.metadataStore.data.files);
      this.removeIgnoredFiles(remoteMetadata.files);
      conflictActions = conflictActions.filter(
        (action) => !this.gitignore.ignores(action.filePath),
      );
      conflictResolutions = conflictResolutions.filter(
        (resolution) => !this.gitignore.ignores(resolution.filePath),
      );
      actions = await determineActions();
    }

    if (actions.length === 0) {
      // Nothing to sync
      await this.logger.info("Nothing to sync");
      this.metadataStore.data.syncedWith = this.remoteId();
      await this.metadataStore.save();
      return buildSyncSummary(
        { added: [], updated: [], deleted: [] },
        // The .gitignore might have been the only change
        { downloaded: gitignoreDownloaded, deleted: [] },
      );
    }
    await this.logger.info("Actions to sync", actions);

    const newTreeFiles: { [key: string]: NewTreeRequestItem } = Object.keys(
      files,
    )
      .map((filePath: string) => ({
        path: files[filePath].path,
        mode: files[filePath].mode,
        type: files[filePath].type,
        sha: files[filePath].sha,
      }))
      .reduce(
        (
          acc: { [key: string]: NewTreeRequestItem },
          item: NewTreeRequestItem,
        ) => ({ ...acc, [item.path]: item }),
        {},
      );

    await Promise.all(
      actions.map(async (action) => {
        switch (action.type) {
          case "upload": {
            const normalizedPath = normalizePath(action.filePath);
            const resolution = conflictResolutions.find(
              (c: ConflictResolution) => c.filePath === action.filePath,
            );
            // If the file was conflicting we need to read the content from the
            // conflict resolution instead of reading it from file since at this point
            // we still have not updated the local file.
            const content =
              resolution?.content ||
              (await this.vault.adapter.read(normalizedPath));
            newTreeFiles[action.filePath] = {
              path: action.filePath,
              mode: "100644",
              type: "blob",
              content: content,
            };
            break;
          }
          case "delete_remote": {
            if (newTreeFiles[action.filePath]) {
              // If it's not in the tree it's already gone
              newTreeFiles[action.filePath].sha = null;
            }
            break;
          }
          case "download":
            break;
          case "delete_local":
            break;
        }
      }),
    );

    // Download files and delete local files
    await Promise.all([
      ...actions
        .filter((action) => action.type === "download")
        .map(async (action: SyncAction) => {
          await this.downloadFile(
            files[action.filePath],
            remoteMetadata.files[action.filePath].lastModified,
          );
        }),
      ...actions
        .filter((action) => action.type === "delete_local")
        .map(async (action: SyncAction) => {
          await this.deleteLocalFile(action.filePath);
        }),
    ]);

    const uploads = actions
      .filter((action) => action.type === "upload")
      .map((action) => action.filePath);
    const changes: CommitChanges = {
      added: uploads.filter((filePath) => !files[filePath]),
      updated: uploads.filter((filePath) => files[filePath]),
      deleted: actions
        .filter(
          (action) => action.type === "delete_remote" && files[action.filePath],
        )
        .map((action) => action.filePath),
    };
    const sent = await this.commitSync(
      newTreeFiles,
      treeSha,
      changes,
      conflictResolutions,
    );
    return buildSyncSummary(sent, {
      downloaded: [
        ...gitignoreDownloaded,
        ...actions
          .filter((action) => action.type === "download")
          .map((action) => action.filePath),
      ],
      deleted: actions
        .filter((action) => action.type === "delete_local")
        .map((action) => action.filePath),
    });
  }

  /**
   * Finds conflicts between local and remote files.
   * @param filesMetadata Remote files metadata
   * @returns List of object containing file path, remote and local content of conflicting files
   */
  async findConflicts(filesMetadata: {
    [key: string]: FileMetadata;
  }): Promise<ConflictFile[]> {
    const commonFiles = Object.keys(filesMetadata).filter(
      (key) => key in this.metadataStore.data.files,
    );
    if (commonFiles.length === 0) {
      return [];
    }

    const conflicts = await Promise.all(
      commonFiles.map(async (filePath: string) => {
        if (filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`) {
          // The manifest file is only internal, the user must not
          // handle conflicts for this
          return null;
        }
        const remoteFile = filesMetadata[filePath];
        const localFile = this.metadataStore.data.files[filePath];
        if (remoteFile.deleted || localFile.deleted) {
          // A deleted file has no content to compare, which side wins is
          // decided when determining the sync actions.
          return null;
        }
        const actualLocalSHA = await this.calculateSHA(filePath);
        const remoteFileHasBeenModifiedSinceLastSync =
          remoteFile.sha !== localFile.sha;
        const localFileHasBeenModifiedSinceLastSync =
          actualLocalSHA !== localFile.sha;
        // This is an unlikely case. If the user manually edits
        // the local file so that's identical to the remote one,
        // but the local metadata SHA is different we don't want
        // to show a conflict.
        // Since that would show two identical files.
        // Checking for this prevents showing a non conflict to the user.
        const actualFilesAreDifferent = remoteFile.sha !== actualLocalSHA;
        if (
          remoteFileHasBeenModifiedSinceLastSync &&
          localFileHasBeenModifiedSinceLastSync &&
          actualFilesAreDifferent
        ) {
          return filePath;
        }
        return null;
      }),
    );

    return await Promise.all(
      conflicts
        .filter((filePath): filePath is string => filePath !== null)
        .map(async (filePath: string) => {
          // Load contents in parallel
          const [remoteContent, localContent] = await Promise.all([
            await (async () => {
              const res = await this.client.getBlob({
                sha: filesMetadata[filePath].sha!,
                retry: true,
                maxRetries: 1,
              });
              return decodeBase64String(res.content);
            })(),
            await this.vault.adapter.read(normalizePath(filePath)),
          ]);
          return {
            filePath,
            remoteContent,
            localContent,
          };
        }),
    );
  }

  /**
   * Determines which sync action to take for each file.
   *
   * @param remoteFiles All files in the remote repo
   * @param localFiles All files in the local vault
   * @param conflictFiles List of paths to files that have conflict with remote
   * @param remoteTree All files in the remote repository
   *
   * @returns List of SyncActions
   */
  async determineSyncActions(
    remoteFiles: { [key: string]: FileMetadata },
    localFiles: { [key: string]: FileMetadata },
    conflictFiles: string[],
    remoteTree: { [key: string]: GetTreeResponseItem } = {},
  ) {
    let actions: SyncAction[] = [];

    const commonFiles = Object.keys(remoteFiles)
      .filter((filePath) => filePath in localFiles)
      // Remove conflicting files, we determine their actions in a different way
      .filter((filePath) => !conflictFiles.contains(filePath));

    // Get diff for common files
    await Promise.all(
      commonFiles.map(async (filePath: string) => {
        if (filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`) {
          // The manifest file must never trigger any action
          return;
        }

        const remoteFile = remoteFiles[filePath];
        const localFile = localFiles[filePath];
        if (remoteFile.deleted && localFile.deleted) {
          // Nothing to do
          return;
        }

        const localSHA = await this.calculateSHA(filePath);
        if (
          !remoteFile.deleted &&
          !localFile.deleted &&
          remoteFile.sha === localSHA
        ) {
          // A deleted file keeps the SHA it had, so this must be checked only if
          // the file exists on both sides or deletions would never be synced.
          //
          // If the remote file sha is identical to the actual sha of the local file
          // there are no actions to take.
          // We calculate the SHA at the moment instead of using the one stored in the
          // metadata file cause we update that only when the file is uploaded or downloaded.
          return;
        }

        if (remoteFile.deleted && !localFile.deleted) {
          if ((remoteFile.deletedAt as number) > localFile.lastModified) {
            actions.push({
              type: "delete_local",
              filePath: filePath,
            });
            return;
          } else if (
            localFile.lastModified > (remoteFile.deletedAt as number)
          ) {
            actions.push({ type: "upload", filePath: filePath });
            return;
          }
        }

        if (!remoteFile.deleted && localFile.deleted) {
          if (remoteFile.lastModified > (localFile.deletedAt as number)) {
            actions.push({ type: "download", filePath: filePath });
            return;
          } else if (
            (localFile.deletedAt as number) > remoteFile.lastModified
          ) {
            actions.push({
              type: "delete_remote",
              filePath: filePath,
            });
            return;
          }
        }

        // For non-deletion cases, if SHAs differ, we just need to check if local changed.
        // Conflicts are already filtered out so we can make this decision easily
        if (localSHA !== localFile.sha) {
          actions.push({ type: "upload", filePath: filePath });
          return;
        } else {
          actions.push({ type: "download", filePath: filePath });
          return;
        }
      }),
    );

    // Get diff for files in remote but not in local
    Object.keys(remoteFiles).forEach((filePath: string) => {
      const remoteFile = remoteFiles[filePath];
      const localFile = localFiles[filePath];
      if (localFile) {
        // Local file exists, we already handled it.
        // Skip it.
        return;
      }
      if (remoteFile.deleted) {
        // Remote is deleted but we don't have it locally.
        // Nothing to do.
        // TODO: Maybe we need to remove remote reference too?
      } else {
        actions.push({ type: "download", filePath: filePath });
      }
    });

    // Get diff for files in local but not in remote
    // A file with a SHA has been in the remote at some point, but we can trust
    // that only if the last successful sync was with this same remote.
    const canTrustLocalSHAs =
      this.metadataStore.data.syncedWith === this.remoteId();
    await Promise.all(
      Object.keys(localFiles).map(async (filePath: string) => {
        const remoteFile = remoteFiles[filePath];
        const localFile = localFiles[filePath];
        if (remoteFile) {
          // Remote file exists, we already handled it.
          // Skip it.
          return;
        }
        if (localFile.deleted) {
          // Local is deleted and remote doesn't exist.
          // Nothing to do.
          return;
        }
        if (
          canTrustLocalSHAs &&
          localFile.sha !== null &&
          !remoteTree[filePath]
        ) {
          // We synced this file in the past but now there's no trace of it in
          // the remote. It has been deleted from another device and it's not
          // tracked as deleted anymore.
          const localSHA = await this.calculateSHA(filePath);
          if (localSHA === null) {
            // It's gone locally too
            localFile.deleted = true;
            localFile.deletedAt = Date.now();
            return;
          }
          if (localSHA === localFile.sha) {
            // It has not changed since the last sync, it's safe to delete it
            actions.push({ type: "delete_local", filePath: filePath });
            return;
          }
          // It has been edited locally after the last sync, so we keep it
          // and upload it again.
        }
        actions.push({ type: "upload", filePath: filePath });
      }),
    );

    if (!this.settings.syncConfigDir) {
      // Remove all actions that involve the config directory if the user doesn't want to sync it.
      // The manifest file is always synced.
      return actions.filter((action: SyncAction) => {
        return (
          !action.filePath.startsWith(this.vault.configDir) ||
          action.filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`
        );
      });
    }

    return actions;
  }

  /**
   * Calculates the SHA1 of a file given its content.
   * This is the same identical algoritm used by git to calculate
   * a blob's SHA.
   * @param filePath normalized path to file
   * @returns String containing the file SHA1 or null in case the file doesn't exist
   */
  async calculateSHA(filePath: string): Promise<string | null> {
    if (!(await this.vault.adapter.exists(filePath))) {
      // The file doesn't exist, can't calculate any SHA
      return null;
    }
    const contentBuffer = await this.vault.adapter.readBinary(filePath);
    return await this.calculateBlobSHA(new Uint8Array(contentBuffer));
  }

  /**
   * Calculates the SHA git gives to a blob with this content.
   * @param contentBytes content of the blob
   */
  private async calculateBlobSHA(contentBytes: Uint8Array): Promise<string> {
    const header = new TextEncoder().encode(`blob ${contentBytes.length}\0`);
    const store = new Uint8Array([...header, ...contentBytes]);
    return await crypto.subtle.digest("SHA-1", store).then((hash) =>
      Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );
  }

  /**
   * Creates a new sync commit in the remote repository.
   *
   * @param treeFiles Updated list of files in the remote tree
   * @param baseTreeSha sha of the tree to use as base for the new tree
   * @param changes files the commit adds, updates and deletes in the remote
   * @param conflictResolutions list of conflicts between remote and local files
   * @param firstSync whether this is the first sync of this device
   *
   * @returns the files the commit added, updated and deleted in the remote
   */
  async commitSync(
    treeFiles: { [key: string]: NewTreeRequestItem },
    baseTreeSha: string,
    changes: CommitChanges,
    conflictResolutions: ConflictResolution[] = [],
    firstSync: boolean = false,
  ): Promise<CommitChanges> {
    const manifestPath = `${this.vault.configDir}/${MANIFEST_FILE_NAME}`;
    const isNotManifest = (filePath: string) => filePath !== manifestPath;
    changes = {
      added: changes.added.filter(isNotManifest),
      updated: changes.updated.filter(isNotManifest),
      deleted: changes.deleted.filter(isNotManifest),
    };

    // Our settings must never be in the remote as they contain the GitHub token.
    // Older versions of the plugin synced them together with the other configs,
    // if that's the case we remove them.
    const pluginSettings = treeFiles[this.gitignore.pluginSettingsPath()];
    if (pluginSettings) {
      pluginSettings.sha = null;
      delete pluginSettings.content;
      changes.deleted.push(pluginSettings.path);
    }

    // Update local sync time
    const syncTime = Date.now();
    this.metadataStore.data.lastSync = syncTime;
    this.metadataStore.save();

    // We update the last modified timestamp for all files that had resolved conflicts
    // to the the same time as the sync time.
    // At this time we still have not written the conflict resolution content to file,
    // so the last modified timestamp doesn't reflect that.
    // To prevent further conflicts in future syncs and to reflect the content change
    // on the remote metadata we update the timestamp for the conflicting files here,
    // just before pushing to remote.
    // We're going to update the local content when the sync is successful.
    conflictResolutions.forEach((resolution) => {
      this.metadataStore.data.files[resolution.filePath].lastModified =
        syncTime;
    });

    // We want the remote metadata file to track the correct SHA for each file blob,
    // so just before we upload any file we update all their SHAs in the metadata file.
    // This also makes it easier to handle conflicts.
    // We don't save the metadata file after setting the SHAs cause we do that when
    // the sync is fully commited at the end.
    // The SHAs are set in the local metadata only when the sync is fully commited,
    // if they were set and the sync failed we would believe files that never
    // reached the remote have been synced.
    //
    // In here we also upload blob is file is a binary. We do it here because when uploading a blob we
    // also get back its SHA, so we can set it together with other files.
    // We also do that right before creating the new tree because we need the SHAs of those blob to
    // correctly create it.
    const newSHAs: { [key: string]: string | null } = {};
    const uploadedBlobs = new Set<string>();
    await Promise.all(
      Object.keys(treeFiles)
        .filter((filePath: string) => treeFiles[filePath].content)
        .map(async (filePath: string) => {
          // I don't fully trust file extensions as they're not completely reliable
          // to determine the file type, though I feel it's ok to compromise and rely
          // on them if it makes the plugin handle upload better on certain devices.
          if (hasTextExtension(filePath)) {
            const resolution = conflictResolutions.find(
              (c: ConflictResolution) => c.filePath === filePath,
            );
            // The content of a conflict resolution is written to the local
            // file only after the sync is done, so the SHA must be the one
            // of the content we upload, not of the file.
            newSHAs[filePath] = resolution?.content
              ? await this.calculateBlobSHA(
                  new TextEncoder().encode(resolution.content),
                )
              : await this.calculateSHA(filePath);
            return;
          }

          // We can't upload binary files by setting the content of a tree item,
          // we first need to create a Git blob by uploading the file, then
          // we must update the tree item to point the SHA to the blob we just created.
          const buffer = await this.vault.adapter.readBinary(filePath);
          const { sha } = await this.client.createBlob({
            content: arrayBufferToBase64(buffer),
            retry: true,
            maxRetries: 3,
          });
          await this.logger.info("Created blob", filePath);
          uploadedBlobs.add(filePath);
          treeFiles[filePath].sha = sha;
          // Can't have both sha and content set, so we delete it
          delete treeFiles[filePath].content;
          newSHAs[filePath] = sha;
        }),
    );

    // Update manifest in list of new tree items
    delete treeFiles[`${this.vault.configDir}/${MANIFEST_FILE_NAME}`].sha;
    const setSyncedState = (metadata: Metadata) => {
      Object.keys(newSHAs)
        .filter((filePath: string) => metadata.files[filePath])
        .forEach((filePath: string) => {
          metadata.files[filePath].sha = newSHAs[filePath];
        });
      metadata.syncedWith = this.remoteId();
    };
    // The remote manifest must describe the state after this sync
    const remoteMetadata: Metadata = JSON.parse(
      JSON.stringify(this.metadataStore.data),
    );
    setSyncedState(remoteMetadata);
    treeFiles[`${this.vault.configDir}/${MANIFEST_FILE_NAME}`].content =
      JSON.stringify(remoteMetadata);

    // Create the new tree.
    // We only send the files this sync changes, all the others are taken from
    // the base tree. If we sent them all with the SHAs we know, we would
    // overwrite any change made to the remote that we're not aware of.
    const newTree: { tree: NewTreeRequestItem[]; base_tree: string } = {
      tree: Object.keys(treeFiles)
        .filter(
          (filePath: string) =>
            treeFiles[filePath].content !== undefined ||
            treeFiles[filePath].sha === null ||
            uploadedBlobs.has(filePath),
        )
        .map((filePath: string) => treeFiles[filePath]),
      base_tree: baseTreeSha,
    };
    const newTreeSha = await this.client.createTree({
      tree: newTree,
      retry: true,
    });

    // The parent must be the commit we read the remote content from, not the
    // current branch head. If the two are different the branch update fails,
    // as it must, since we don't know what changed in the meantime.
    const commitSha = await this.client.createCommit({
      message: buildCommitMessage(changes, this.deviceName(), firstSync),
      treeSha: newTreeSha,
      parent: this.remoteHeadSha,
    });

    await this.client.updateBranchHead({
      sha: commitSha,
      retry: true,
      // If the branch moved retrying is not going to help, fail fast
      maxRetries: 2,
    });

    // The sync is commited, now the files we uploaded are in the remote
    setSyncedState(this.metadataStore.data);

    // Update the local content of all files that had conflicts we resolved
    await Promise.all(
      conflictResolutions.map(async (resolution) => {
        await this.vault.adapter.write(resolution.filePath, resolution.content);
        // Even though we set the last modified timestamp for all files with conflicts
        // just before pushing the changes to remote we do it here again because the
        // write right above would overwrite that.
        // Since we want to keep the sync timestamp for this file to avoid future conflicts
        // we update it again.
        this.metadataStore.data.files[resolution.filePath].lastModified =
          syncTime;
      }),
    );
    // Now that the sync is done and we updated the content for conflicting files
    // we can save the latest metadata to disk.
    this.metadataStore.save();
    await this.logger.info("Sync done");
    return changes;
  }

  async downloadFile(file: GetTreeResponseItem, lastModified: number) {
    const fileMetadata = this.metadataStore.data.files[file.path];
    if (fileMetadata && fileMetadata.sha === file.sha) {
      // File already exists and has the same SHA, no need to download it again.
      return;
    }
    const blob = await this.client.getBlob({ sha: file.sha, retry: true });
    const normalizedPath = normalizePath(file.path);
    const fileFolder = normalizePath(
      normalizedPath.split("/").slice(0, -1).join("/"),
    );
    if (!(await this.vault.adapter.exists(fileFolder))) {
      await this.vault.adapter.mkdir(fileFolder);
    }
    await this.vault.adapter.writeBinary(
      normalizedPath,
      base64ToArrayBuffer(blob.content),
    );
    this.metadataStore.data.files[file.path] = {
      path: file.path,
      sha: file.sha,
      dirty: false,
      justDownloaded: true,
      lastModified: lastModified,
    };
    await this.metadataStore.save();
  }

  async deleteLocalFile(filePath: string) {
    const normalizedPath = normalizePath(filePath);
    await this.vault.adapter.remove(normalizedPath);
    this.metadataStore.data.files[filePath].deleted = true;
    this.metadataStore.data.files[filePath].deletedAt = Date.now();
    this.metadataStore.save();
  }

  async loadMetadata() {
    await this.logger.info("Loading metadata");
    await this.metadataStore.load();
    await this.gitignore.load();
    if (Object.keys(this.metadataStore.data.files).length === 0) {
      await this.logger.info("Metadata was empty, loading all files");
      let files = [];
      let folders = [this.vault.getRoot().path];
      while (folders.length > 0) {
        const folder = folders.pop();
        if (folder === undefined) {
          continue;
        }
        if (!this.settings.syncConfigDir && folder === this.vault.configDir) {
          await this.logger.info("Skipping config dir");
          // Skip the config dir if the user doesn't want to sync it
          continue;
        }
        if (this.gitignore.ignores(`${folder}/`)) {
          await this.logger.info("Skipping ignored folder", folder);
          continue;
        }
        const res = await this.vault.adapter.list(folder);
        files.push(...res.files);
        folders.push(...res.folders);
      }
      files.forEach((filePath: string) => {
        if (filePath === `${this.vault.configDir}/workspace.json`) {
          // Obsidian recommends not syncing the workspace file
          return;
        }
        if (this.gitignore.ignores(filePath)) {
          return;
        }

        this.metadataStore.data.files[filePath] = {
          path: filePath,
          sha: null,
          dirty: false,
          justDownloaded: false,
          lastModified: Date.now(),
        };
      });

      // Must be the first time we run, initialize the metadata store
      // with itself and all files in the vault.
      this.metadataStore.data.files[
        `${this.vault.configDir}/${MANIFEST_FILE_NAME}`
      ] = {
        path: `${this.vault.configDir}/${MANIFEST_FILE_NAME}`,
        sha: null,
        dirty: false,
        justDownloaded: false,
        lastModified: Date.now(),
      };
      this.metadataStore.save();
    }
    await this.logger.info("Loaded metadata");
  }

  /**
   * Add all the files in the config dir in the metadata store.
   * This is mainly useful when the user changes the sync config settings
   * as we need to add those files to the metadata store or they would never be synced.
   */
  async addConfigDirToMetadata() {
    await this.logger.info("Adding config dir to metadata");
    await this.trackHiddenFoldersChanges();
    await this.metadataStore.save();
  }

  /**
   * Remove all the files in the config dir from the metadata store.
   * The metadata file is not removed as it must always be present.
   * This is mainly useful when the user changes the sync config settings
   * as we need to remove those files to the metadata store or they would
   * keep being synced.
   */
  async removeConfigDirFromMetadata() {
    await this.logger.info("Removing config dir from metadata");
    // Get all the files in the config dir
    let files = [];
    let folders = [this.vault.configDir];
    while (folders.length > 0) {
      const folder = folders.pop();
      if (folder === undefined) {
        continue;
      }
      const res = await this.vault.adapter.list(folder);
      files.push(...res.files);
      folders.push(...res.folders);
    }

    // Remove all them from the metadata store
    files.forEach((filePath: string) => {
      if (filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`) {
        // We don't want to remove the metadata file even if it's in the config dir
        return;
      }
      delete this.metadataStore.data.files[filePath];
    });
    this.metadataStore.save();
  }

  getFileMetadata(filePath: string): FileMetadata {
    return this.metadataStore.data.files[filePath];
  }

  startEventsListener(plugin: GitHubSyncPlugin) {
    this.eventsListener.start(plugin);
  }

  /**
   * Starts a new sync interval.
   * Raises an error if the interval is already running.
   */
  startSyncInterval(minutes: number): number {
    if (this.syncIntervalId) {
      throw new Error("Sync interval is already running");
    }
    this.syncIntervalId = window.setInterval(
      async () => await this.sync(),
      // Sync interval is set in minutes but setInterval expects milliseconds
      minutes * 60 * 1000,
    );
    return this.syncIntervalId;
  }

  /**
   * Stops the currently running sync interval
   */
  stopSyncInterval() {
    if (this.syncIntervalId) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  /**
   * Util function that stops and restart the sync interval
   */
  restartSyncInterval(minutes: number) {
    this.stopSyncInterval();
    return this.startSyncInterval(minutes);
  }

  async resetMetadata() {
    this.metadataStore.reset();
    await this.metadataStore.save();
  }
}
