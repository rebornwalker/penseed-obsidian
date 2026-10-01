import { App, Modal, Notice } from "obsidian";
import { ApiError } from "./api";

export interface ReplayItem {
  chapterNumber: number;
  noteTitle: string | null;
}

export interface ReanalysisBatchTaskState {
  taskId: string;
  projectId: number;
  total: number;
  completed: number;
  failed: number;
  currentChapterId: number | null;
  status: "running" | "completed" | "error" | "cancelled";
  error: string | null;
  converged: boolean | null;
  newStaleChapterIds: number[];
  skippedNoNote: number;
  numberById: Map<number, number>;
}

export interface ForeshadowingSummaryItem {
  text: string;
  status: string;
}

export interface EntitySummaryItem {
  name: string;
  type: string;
}

export interface ReanalysisSummary {
  entityCount: number;
  foreshadowingCount: number;
  addedForeshadowings: number;
  deletedForeshadowings: number;
  semanticChangedCount: number;
  resolvedCount: number;
  partiallyResolved: number;
  progressed: number;
  estimatedReplayCredits: number;
  projectId: number;
  affected: ReplayItem[];
  isFirstAnalysis: boolean;
  unchanged?: boolean;
  foreshadowings: ForeshadowingSummaryItem[];
  entities: EntitySummaryItem[];
  onBatchReplay?: () => Promise<void>;
}

export const WEB_BASE_URL = "https://penseed.app";

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

/**
 * Install a draggable resize handle on the bottom-right corner of a modal.
 * Returns a cleanup function to call in onClose. Mirrors AnalysisReviewModal's
 * resize behaviour so every Penseed modal is resizable the same way.
 */
function installModalResize(modal: Modal): () => void {
  const modalEl = modal.modalEl;
  const handle = modalEl.createDiv({ cls: "penseed-resize-handle" });

  let startX = 0;
  let startY = 0;
  let startWidth = 0;
  let startHeight = 0;

  const onMove = (ev: MouseEvent): void => {
    const width = Math.min(
      window.innerWidth - 16,
      Math.max(360, startWidth + (ev.clientX - startX))
    );
    const height = Math.min(
      window.innerHeight - 16,
      Math.max(280, startHeight + (ev.clientY - startY))
    );
    modalEl.style.width = `${width}px`;
    modalEl.style.height = `${height}px`;
  };

  const stop = (): void => {
    document.body.classList.remove("penseed-resizing");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", stop);
  };

  handle.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    startX = ev.clientX;
    startY = ev.clientY;
    startWidth = modalEl.offsetWidth;
    startHeight = modalEl.offsetHeight;
    document.body.classList.add("penseed-resizing");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", stop);
  });

  return stop;
}

export class ReanalysisResultModal extends Modal {
  private summary: ReanalysisSummary;
  private resizeCleanup: (() => void) | null = null;

  constructor(app: App, summary: ReanalysisSummary) {
    super(app);
    this.summary = summary;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("penseed-result");
    this.resizeCleanup = installModalResize(this);

    contentEl.createEl("h2", {
      text: this.summary.isFirstAnalysis
        ? "Penseed Analysis"
        : "Penseed Reanalysis",
    });

    if (!this.summary.isFirstAnalysis) {
      const warn = contentEl.createDiv();
      warn.addClass("penseed-project-report-warning");
      const title = warn.createDiv({
        text: "Heads up — project reports are now manual",
      });
      title.addClass("penseed-warning-title");
      warn.createDiv({
        text: "This re-analysis refreshed this chapter's elements, foreshadowings, and resolutions only. The slower project-wide checks — element conflicts, World State, and rules — no longer run automatically, so re-analysis stays fast and doesn't burn extra AI credits. To keep those reports in sync, open the web app and run them yourself. Until then, they may be out of date.",
      });
    }

    if (this.summary.unchanged) {
      const notice = contentEl.createDiv({
        text: "This chapter hasn't changed since your last analysis, so Penseed skipped the re-run. Your notes are already up to date — no credits were used.",
      });
      notice.addClass("penseed-unchanged-notice");
    }

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

    const resolutionParts: string[] = [];
    if (this.summary.resolvedCount > 0) {
      resolutionParts.push(`${this.summary.resolvedCount} fully resolved`);
    }
    if (this.summary.partiallyResolved > 0) {
      resolutionParts.push(
        `${this.summary.partiallyResolved} partially resolved`
      );
    }
    if (this.summary.progressed > 0) {
      resolutionParts.push(`${this.summary.progressed} progressed`);
    }
    if (resolutionParts.length > 0) {
      contentEl.createDiv({ text: resolutionParts.join(" · ") });
    }

    // Read-only listing of what this chapter extracted. Editing/removal stays
    // on the web app, so we call that out prominently rather than offer controls.
    const hasItems =
      this.summary.foreshadowings.length > 0 || this.summary.entities.length > 0;
    if (hasItems) {
      const manageNotice = contentEl.createDiv({
        text: "These items are read-only here. Edit or remove foreshadowings and elements on the Penseed web app.",
      });
      manageNotice.addClass("penseed-manage-notice");
    }

    if (this.summary.foreshadowings.length > 0) {
      contentEl.createEl("h3", { text: "Foreshadowings" });
      const fsList = contentEl.createEl("ul");
      fsList.addClass("penseed-item-list");
      for (const f of this.summary.foreshadowings) {
        const li = fsList.createEl("li");
        li.addClass("penseed-item-row");
        li.createSpan({ text: f.text || "(untitled)" });
        if (f.status) {
          li.createSpan({ text: f.status, cls: "penseed-status-tag" });
        }
      }
    }

    if (this.summary.entities.length > 0) {
      contentEl.createEl("h3", { text: "Elements" });
      const entList = contentEl.createEl("ul");
      entList.addClass("penseed-item-list");
      for (const e of this.summary.entities) {
        const li = entList.createEl("li");
        li.addClass("penseed-item-row");
        li.createSpan({ text: e.name });
        if (e.type) {
          li.createSpan({ text: e.type, cls: "penseed-status-tag" });
        }
      }
    }

    if (this.summary.affected.length > 0) {
      contentEl
        .createDiv({
          text: `${this.summary.affected.length} downstream chapter${plural(
            this.summary.affected.length
          )} affected`,
        })
        .addClass("penseed-cta-label");

      if (this.summary.estimatedReplayCredits > 0) {
        contentEl.createDiv({
          text: `Estimated ${this.summary.estimatedReplayCredits} credits to re-analyze all downstream chapters.`,
        });
      }

      // Read-only list of affected chapters. Individual per-row "re-analyze" is
      // deliberately removed: re-analyzing a single stale chapter out of order
      // corrupts downstream state (cascade/butterfly effect). The only action is
      // one batch button that re-analyzes the whole set in chapter order.
      const list = contentEl.createEl("ul");
      list.addClass("penseed-item-list");
      for (const item of this.summary.affected) {
        const li = list.createEl("li");
        li.addClass("penseed-item-row");
        const label = item.noteTitle
          ? `Chapter ${item.chapterNumber} — ${item.noteTitle}`
          : `Chapter ${item.chapterNumber} — note not found`;
        li.createSpan({ text: label });
      }

      if (this.summary.onBatchReplay) {
        this.renderBatchReplay(contentEl);
      }
    }

    const button = contentEl.createEl("button", { text: "Open Penseed" });
    button.addClass("penseed-open-button");
    button.addEventListener("click", () => {
      window.open(`${WEB_BASE_URL}/projects/${this.summary.projectId}`, "_blank");
      this.close();
    });
  }

  private renderBatchReplay(parent: HTMLElement): void {
    const container = parent.createDiv({ cls: "penseed-batch" });

    const button = container.createEl("button", {
      text: "Batch re-analyze outdated chapters",
    });
    button.addClass("mod-cta");
    button.addClass("penseed-batch-button");

    button.addEventListener("click", () => {
      void (async () => {
        button.disabled = true;
        button.setText("Submitting…");
        try {
          await this.summary.onBatchReplay!();
          // The backend now runs the wave. Close this modal; progress moves to
          // the status bar, and clicking it re-opens a live progress view.
          this.close();
        } catch (e) {
          button.disabled = false;
          button.setText("Batch re-analyze failed — retry");
          new Notice(
            e instanceof ApiError
              ? e.userMessage
              : "Batch re-analysis failed. Check the Penseed web app for details."
          );
          console.error("[Penseed] Batch re-analysis failed", e);
        }
      })();
    });
  }

  onClose(): void {
    this.resizeCleanup?.();
    this.resizeCleanup = null;
    const { contentEl } = this;
    contentEl.empty();
  }
}

/**
 * Live progress / result view for a background batch-reanalysis task. Subscribes
 * to the plugin's task state via getState and refreshes on an interval, so the
 * author can close and reopen it without interrupting the backend task.
 */
export class BatchProgressModal extends Modal {
  private getState: () => ReanalysisBatchTaskState | null;
  private onCancel: (() => Promise<void>) | null;
  private interval: number | null = null;
  private resizeCleanup: (() => void) | null = null;

  constructor(
    app: App,
    getState: () => ReanalysisBatchTaskState | null,
    onCancel: (() => Promise<void>) | null = null
  ) {
    super(app);
    this.getState = getState;
    this.onCancel = onCancel;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("penseed-result");
    this.resizeCleanup = installModalResize(this);
    this.render();
    this.interval = window.setInterval(() => this.render(), 1500);
  }

  onClose(): void {
    if (this.interval !== null) {
      window.clearInterval(this.interval);
      this.interval = null;
    }
    this.resizeCleanup?.();
    this.resizeCleanup = null;
    const { contentEl } = this;
    contentEl.empty();
  }

  private render(): void {
    const state = this.getState();
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Batch Re-analysis" });

    if (!state) {
      contentEl.createDiv({ text: "No batch re-analysis task in progress." });
      return;
    }

    if (state.status === "running") {
      const total = state.total || 0;
      const completed = state.completed || 0;
      contentEl.createDiv({
        text: `Re-analyzing ${completed}/${total}${
          state.failed > 0 ? ` — ${state.failed} failed` : ""
        }`,
      });
      if (state.currentChapterId != null) {
        const chapterNumber = state.numberById.get(state.currentChapterId);
        contentEl.createDiv({
          text:
            chapterNumber != null
              ? `Current chapter: ${chapterNumber}`
              : `Current chapter id: ${state.currentChapterId}`,
        });
      }
      if (this.onCancel) {
        const cancel = contentEl.createEl("button", { text: "Cancel" });
        cancel.addClass("penseed-batch-button");
        cancel.addEventListener("click", () => {
          void this.onCancel!();
        });
      }
    } else if (state.status === "completed") {
      const parts: string[] = [
        `${state.completed} chapter${plural(state.completed)} re-analyzed`,
      ];
      if (state.skippedNoNote > 0) {
        parts.push(`${state.skippedNoNote} skipped (no local note)`);
      }
      if (state.failed > 0) {
        parts.push(`${state.failed} failed`);
      }
      contentEl.createDiv({ text: parts.join(", ") + "." });
      if (state.converged === false && state.newStaleChapterIds.length > 0) {
        contentEl.createDiv({
          text: `${state.newStaleChapterIds.length} more chapter${plural(
            state.newStaleChapterIds.length
          )} now out of date — open Penseed to continue.`,
        });
      }
    } else if (state.status === "error") {
      contentEl.createDiv({
        text: state.error || "Batch re-analysis failed.",
      });
    } else {
      contentEl.createDiv({ text: "Batch re-analysis cancelled." });
    }
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
