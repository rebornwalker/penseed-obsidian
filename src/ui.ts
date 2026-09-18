import { App, Modal } from "obsidian";

export interface AnalysisSummary {
  foreshadowingCount: number;
  foreshadowingSkipped: number;
  entityCount: number;
  projectId: number;
}

const WEB_BASE_URL = "https://penseed.app";

export class AnalysisResultModal extends Modal {
  private summary: AnalysisSummary;

  constructor(app: App, summary: AnalysisSummary) {
    super(app);
    this.summary = summary;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("penseed-result");

    contentEl.createEl("h2", { text: "Penseed Analysis" });

    const skippedText =
      this.summary.foreshadowingSkipped > 0
        ? ` (skipped ${this.summary.foreshadowingSkipped} duplicate${
            this.summary.foreshadowingSkipped === 1 ? "" : "s"
          })`
        : "";
    contentEl.createEl("div", {
      text: `Saved ${this.summary.foreshadowingCount} foreshadowing ${
        this.summary.foreshadowingCount === 1 ? "candidate" : "candidates"
      }${skippedText}`,
    });
    contentEl.createEl("div", {
      text: `Saved ${this.summary.entityCount} entity ${
        this.summary.entityCount === 1 ? "candidate" : "candidates"
      }`,
    });

    contentEl
      .createEl("p", { text: "Open in Penseed to:" })
      .addClass("penseed-cta-label");

    const list = contentEl.createEl("ul");
    list.createEl("li", {
      text: "Manage foreshadowing on a drag-and-drop board",
    });
    list.createEl("li", {
      text: "Auto-detect character & plot conflicts across chapters",
    });
    list.createEl("li", {
      text: "Track every thread from planted → developed → resolved",
    });

    const button = contentEl.createEl("button", { text: "Open Penseed" });
    button.addClass("penseed-open-button");
    button.addEventListener("click", () => {
      window.open(`${WEB_BASE_URL}/projects/${this.summary.projectId}`, "_blank");
      this.close();
    });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
