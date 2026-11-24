import { App, Modal, Setting } from "obsidian";
import { Side, pluralize } from "./side";

export type ConfirmAcceptAll = (
  side: Side,
  fileCount: number,
) => Promise<boolean>;

/// Asks before resolving every remaining conflict with the same side,
/// it overwrites the other version of many files at once.
export const confirmAcceptAll =
  (app: App): ConfirmAcceptAll =>
  (side, fileCount) =>
    new Promise((resolve) => {
      const other = side === "local" ? "remote" : "local";
      const filesText = fileCount === 1 ? "file" : pluralize(fileCount, "file");
      const their = fileCount === 1 ? "its" : "their";
      const modal = new Modal(app);
      let confirmed = false;
      modal.titleEl.setText(`Keep the ${side} version of all files?`);
      modal.contentEl.createEl("p", {
        text: `The ${side} version of the remaining ${filesText} is kept and ${their} ${other} changes are overwritten. Conflicts you already resolved stay as they are.`,
      });
      new Setting(modal.contentEl)
        .addButton((button) =>
          button.setButtonText("Cancel").onClick(() => modal.close()),
        )
        .addButton((button) =>
          button
            .setButtonText(`Keep ${side}`)
            .setWarning()
            .onClick(() => {
              confirmed = true;
              modal.close();
            }),
        );
      modal.onClose = () => resolve(confirmed);
      modal.open();
    });
