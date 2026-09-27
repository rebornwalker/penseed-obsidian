import { App, Modal } from "obsidian";

export interface ReplayItem {
  chapterNumber: number;
  noteTitle: string | null;
  onReplay: () => Promise<boolean>;
}

export interface ReanalysisSummary {
  entityCount: number;
  foreshadowingCount: number;
  addedForeshadowings: number;
  deletedForeshadowings: number;
  semanticChangedCount: number;
  resolvedCount: number;
  estimatedReplayCredits: number;
  projectId: number;
  affected: ReplayItem[];
  isFirstAnalysis: boolean;
}

const WEB_BASE_URL = "https://penseed.app";

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

export class ReanalysisResultModal extends Modal {
  private summary: ReanalysisSummary;

  constructor(app: App, summary: ReanalysisSummary) {
    super(app);
    this.summary = summary;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("penseed-result");

    contentEl.createEl("h2", {
      text: this.summary.isFirstAnalysis
        ? "Penseed Analysis"
        : "Penseed Reanalysis",
    });

    contentEl.createDiv({
      text: `${this.summary.entityCount} element${plural(
        this.summary.entityCount
      )}, ${this.summary.foreshadowingCount} foreshadowing${plural(
        this.summary.foreshadowingCount
      )}`,
    });

    if (
      !this.summary.isFirstAnalysis &&
      (this.summary.addedForeshadowings > 0 ||
        this.summary.deletedForeshadowings > 0)
    ) {
      contentEl.createDiv({
        text: `+${this.summary.addedForeshadowings} added / -${this.summary.deletedForeshadowings} removed`,
      });
    }

    if (this.summary.semanticChangedCount > 0) {
      contentEl.createDiv({
        text: `${this.summary.semanticChangedCount} foreshadowing${plural(
          this.summary.semanticChangedCount
        )} changed meaning`,
      });
    }

    if (this.summary.resolvedCount > 0) {
      contentEl.createDiv({
        text: `${this.summary.resolvedCount} foreshadowing${plural(
          this.summary.resolvedCount
        )} resolved`,
      });
    }

    if (this.summary.affected.length > 0) {
      contentEl
        .createDiv({
          text: `${this.summary.affected.length} downstream chapter${plural(
            this.summary.affected.length
          )} affected — re-analyze them to refresh`,
        })
        .addClass("penseed-cta-label");

      if (this.summary.estimatedReplayCredits > 0) {
        contentEl.createDiv({
          text: `Estimated ${this.summary.estimatedReplayCredits} credits to re-analyze all downstream chapters.`,
        });
      }

      const list = contentEl.createEl("ul");
      for (const item of this.summary.affected) {
        this.renderReplayRow(list, item);
      }
    }

    const button = contentEl.createEl("button", { text: "Open Penseed" });
    button.addClass("penseed-open-button");
    button.addEventListener("click", () => {
      window.open(`${WEB_BASE_URL}/projects/${this.summary.projectId}`, "_blank");
      this.close();
    });
  }

  private renderReplayRow(list: HTMLElement, item: ReplayItem): void {
    const li = list.createEl("li");
    li.addClass("penseed-replay-row");

    const label = item.noteTitle
      ? `Chapter ${item.chapterNumber} — ${item.noteTitle}`
      : `Chapter ${item.chapterNumber} — note not found`;
    li.createSpan({ text: label });

    const replayBtn = li.createEl("button", { text: "Re-analyze now" });
    replayBtn.addClass("penseed-replay-button");
    replayBtn.disabled = item.noteTitle === null;

    const ignoreBtn = li.createEl("button", { text: "Ignore" });
    ignoreBtn.addClass("penseed-ignore-button");

    replayBtn.addEventListener("click", () => {
      void (async () => {
        replayBtn.disabled = true;
        replayBtn.textContent = "Re-analyzing...";
        try {
          const ok = await item.onReplay();
          replayBtn.textContent = ok ? "Done" : "Failed";
          ignoreBtn.remove();
        } catch {
          replayBtn.textContent = "Failed";
        }
      })();
    });

    ignoreBtn.addEventListener("click", () => {
      li.remove();
    });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export type ReanalysisDecision = "overwrite" | "choose-other" | "cancel";

export interface ReanalysisTarget {
  projectTitle: string;
  chapterNumber: number | null;
  chapterTitle: string | null;
}

/**
 * Confirmation gate shown before an in-place reanalysis overwrites an existing
 * chapter. The plugin maps local notes to Penseed chapters by chapter_number,
 * so a note can silently collide with an existing chapter in the remembered
 * project. This makes the destructive overwrite explicit and offers an escape
 * hatch to re-pick the project.
 */
export class ConfirmReanalysisModal extends Modal {
  private target: ReanalysisTarget;
  private resolve: (decision: ReanalysisDecision) => void;
  private settled = false;

  constructor(
    app: App,
    target: ReanalysisTarget,
    resolve: (decision: ReanalysisDecision) => void
  ) {
    super(app);
    this.target = target;
    this.resolve = resolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("penseed-confirm");

    contentEl.createEl("h2", { text: "Chapter already exists" });

    const numberLabel =
      this.target.chapterNumber !== null
        ? `Chapter ${this.target.chapterNumber}`
        : "This chapter";
    const titleLabel = this.target.chapterTitle
      ? ` "${this.target.chapterTitle}"`
      : "";
    contentEl.createDiv({
      text: `Project "${this.target.projectTitle}" already has ${numberLabel}${titleLabel}. Re-analyzing this note will overwrite its existing elements, foreshadowing, and resolution analysis.`,
    });

    const actions = contentEl.createDiv({ cls: "penseed-confirm-actions" });

    const overwriteBtn = actions.createEl("button", {
      text: "Overwrite & Re-analyze",
      cls: "mod-cta",
    });
    overwriteBtn.addEventListener("click", () => this.settle("overwrite"));

    const chooseOtherBtn = actions.createEl("button", {
      text: "Choose Different Project",
    });
    chooseOtherBtn.addEventListener("click", () => this.settle("choose-other"));

    const cancelBtn = actions.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.settle("cancel"));
  }

  private settle(decision: ReanalysisDecision): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(decision);
    this.close();
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.resolve("cancel");
    }
    this.contentEl.empty();
  }
}
