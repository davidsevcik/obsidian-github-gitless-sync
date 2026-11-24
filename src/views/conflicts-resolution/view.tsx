import { IconName, ItemView, Menu, Platform, WorkspaceLeaf } from "obsidian";
import { Root, createRoot } from "react-dom/client";
import GitHubSyncPlugin from "src/main";
import { ConflictChoice, ConflictFile } from "src/sync-manager";
import SplitView from "./split-view/split-view";
import UnifiedView from "./unified-view/unified-view";
import { confirmAcceptAll } from "./confirm-accept-all";

export const CONFLICTS_RESOLUTION_VIEW_TYPE = "conflicts-resolution-view";

export class ConflictsResolutionView extends ItemView {
  icon: IconName = "merge";
  private root: Root | null = null;
  // Changes with every new set of conflicts. The views keep the files left to
  // resolve in their state, so they must be created anew for a new set.
  private conflictsKey = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: GitHubSyncPlugin,
    private conflicts: ConflictFile[],
  ) {
    super(leaf);
  }

  getViewType() {
    return CONFLICTS_RESOLUTION_VIEW_TYPE;
  }

  getDisplayText() {
    return "Conflicts resolution";
  }

  private resolveAllConflicts(resolutions: ConflictChoice[]) {
    if (this.plugin.conflictsResolver) {
      this.plugin.conflictsResolver(resolutions);
      this.plugin.conflictsResolver = null;
    }
  }

  setConflictFiles(conflicts: ConflictFile[]) {
    // Reopening the view shows the same set again, keeping the progress
    if (conflicts !== this.conflicts) {
      this.conflictsKey++;
    }
    this.conflicts = conflicts;
    this.render(conflicts);
  }

  async onOpen() {
    this.render(this.conflicts);
  }

  private render(conflicts: ConflictFile[]) {
    if (!this.root) {
      // Hides the navigation header
      (this.containerEl.children[0] as HTMLElement).className =
        "hidden-navigation-header";
      const container = this.containerEl.children[1];
      container.empty();
      // We don't want any padding, the DiffView component will handle that
      (container as HTMLElement).className = "padless-conflicts-view-container";
      this.root = createRoot(container);
    }

    let diffMode = "default";
    if (this.plugin.settings.conflictViewMode === "default") {
      if (Platform.isMobile) {
        diffMode = "unified";
      } else {
        diffMode = "split";
      }
    } else if (this.plugin.settings.conflictViewMode === "split") {
      diffMode = "split";
    } else if (this.plugin.settings.conflictViewMode === "unified") {
      diffMode = "unified";
    }

    if (diffMode === "split") {
      this.root.render(
        <SplitView
          key={this.conflictsKey}
          initialFiles={conflicts}
          onResolveAllConflicts={this.resolveAllConflicts.bind(this)}
          confirmAcceptAll={confirmAcceptAll(this.app)}
        />,
      );
    } else {
      this.root.render(
        <UnifiedView
          key={this.conflictsKey}
          initialFiles={conflicts}
          onResolveAllConflicts={this.resolveAllConflicts.bind(this)}
          confirmAcceptAll={confirmAcceptAll(this.app)}
        />,
      );
    }
  }

  async onClose() {
    // Nothing to clean up.
  }
}
