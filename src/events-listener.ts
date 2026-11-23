import { Vault, TAbstractFile, TFolder } from "obsidian";
import MetadataStore, { MANIFEST_FILE_NAME } from "./metadata-store";
import { GitHubSyncSettings } from "./settings/settings";
import Logger, { LOG_FILE_NAME } from "./logger";
import GitHubSyncPlugin from "./main";
import GitIgnore from "./gitignore";
import { calculateFileSHA } from "./utils";

/**
 * Tracks changes to local sync directory and updates files metadata.
 */
export default class EventsListener {
  constructor(
    private vault: Vault,
    private metadataStore: MetadataStore,
    private settings: GitHubSyncSettings,
    private logger: Logger,
    private gitignore: GitIgnore,
  ) {}

  start(plugin: GitHubSyncPlugin) {
    // We need to register all the events we subscribe to so they can
    // be correctly detached when the plugin is unloaded too.
    // If we don't they might be left hanging and cause issues.
    plugin.registerEvent(this.vault.on("create", this.onCreate.bind(this)));
    plugin.registerEvent(this.vault.on("delete", this.onDelete.bind(this)));
    plugin.registerEvent(this.vault.on("modify", this.onModify.bind(this)));
    plugin.registerEvent(this.vault.on("rename", this.onRename.bind(this)));
  }

  private async onCreate(file: TAbstractFile) {
    await this.logger.info("Received create event", file.path);
    if (!this.isSyncable(file.path)) {
      // The file has not been created in directory that we're syncing with GitHub
      await this.logger.info("Skipped created file", file.path);
      return;
    }
    if (file instanceof TFolder) {
      // Skip folders
      return;
    }

    if (await this.isSyncedContent(file.path)) {
      // The file has been written by a sync, not created by the user
      await this.logger.info("Skipped created file with synced content", file.path);
      return;
    }

    this.metadataStore.data.files[file.path] = {
      path: file.path,
      sha: null,
      dirty: true,
      // This file has been created by the user
      justDownloaded: false,
      lastModified: Date.now(),
    };
    await this.metadataStore.save();
    await this.logger.info("Updated created file", file.path);
  }

  private async onDelete(file: TAbstractFile | string) {
    const filePath = file instanceof TAbstractFile ? file.path : file;
    await this.logger.info("Received delete event", filePath);
    if (file instanceof TFolder) {
      // Skip folders
      return;
    }
    if (!this.isSyncable(filePath)) {
      // The file was not in directory that we're syncing with GitHub
      return;
    }

    if (!this.metadataStore.data.files[filePath]) {
      // We never tracked this file, there's nothing to mark as deleted
      return;
    }
    this.metadataStore.data.files[filePath].deleted = true;
    this.metadataStore.data.files[filePath].deletedAt = Date.now();
    await this.metadataStore.save();
    await this.logger.info("Updated deleted file", filePath);
  }

  private async onModify(file: TAbstractFile) {
    await this.logger.info("Received modify event", file.path);
    if (!this.isSyncable(file.path)) {
      // The file has not been create in directory that we're syncing with GitHub
      await this.logger.info("Skipped modified file", file.path);
      return;
    }
    if (file instanceof TFolder) {
      // Skip folders
      return;
    }
    if (await this.isSyncedContent(file.path)) {
      // The file has been written by a sync, not modified by the user
      await this.logger.info(
        "Skipped modified file with synced content",
        file.path,
      );
      return;
    }
    const data = this.metadataStore.data.files[file.path];
    if (!data) {
      // The file is not tracked, this can happen if it was ignored and
      // it's not anymore. Handle it as if it has just been created.
      await this.onCreate(file);
      return;
    }
    data.lastModified = Date.now();
    data.dirty = true;
    await this.metadataStore.save();
    await this.logger.info("Updated modified file", file.path);
  }

  private async onRename(file: TAbstractFile, oldPath: string) {
    await this.logger.info("Received rename event", file.path);
    if (file instanceof TFolder) {
      // Skip folders
      return;
    }
    if (!this.isSyncable(file.path) && !this.isSyncable(oldPath)) {
      // Both are not in directory that we're syncing with GitHub
      return;
    }

    if (this.isSyncable(file.path) && this.isSyncable(oldPath)) {
      // Both files are in the synced directory
      // First create the new one
      await this.onCreate(file);
      // Then delete the old one
      await this.onDelete(oldPath);
      return;
    } else if (this.isSyncable(file.path)) {
      // Only the new file is in the local directory
      await this.onCreate(file);
      return;
    } else if (this.isSyncable(oldPath)) {
      // Only the old file was in the local directory
      await this.onDelete(oldPath);
      return;
    }
  }

  /**
   * Returns true if the file has the content it had after the last sync, so
   * an event for it is not a change made by the user. That's the case for
   * the events Obsidian sends when a sync downloads a file.
   *
   * The sync updates the metadata before writing the file, so it's always up
   * to date when the event arrives. We compare the content instead of marking
   * the file as just downloaded, since Obsidian doesn't send an event for every
   * write, and a mark left behind would make us miss the next user change.
   */
  private async isSyncedContent(filePath: string): Promise<boolean> {
    const data = this.metadataStore.data.files[filePath];
    if (!data || data.deleted || data.sha === null) {
      return false;
    }
    const synced = (await calculateFileSHA(this.vault, filePath)) === data.sha;
    if (synced && data.justDownloaded) {
      // Not used anymore, but older versions rely on it if the plugin is
      // downgraded
      data.justDownloaded = false;
      await this.metadataStore.save();
    }
    return synced;
  }

  private isSyncable(filePath: string) {
    if (filePath === `${this.vault.configDir}/${MANIFEST_FILE_NAME}`) {
      // Manifest file must always be synced
      return true;
    } else if (
      filePath === `${this.vault.configDir}/workspace.json` ||
      filePath === `${this.vault.configDir}/workspace-mobile.json`
    ) {
      // Obsidian recommends not syncing the workspace files
      return false;
    } else if (filePath === `${this.vault.configDir}/${LOG_FILE_NAME}`) {
      // Don't sync the log file, doesn't make sense
      return false;
    } else if (this.gitignore.ignores(filePath)) {
      // The user doesn't want to sync this
      return false;
    } else if (
      this.settings.syncConfigDir &&
      filePath.startsWith(this.vault.configDir)
    ) {
      // Sync configs only if the user explicitly wants to
      return true;
    } else {
      // All other files can be synced
      return true;
    }
  }
}
