import { App, Modal } from "obsidian";
import { ApiError } from "./api";
import { notify } from "./notify";

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
  currentChapterNumber: number | null;
  status: "running" | "completed" | "error" | "cancelled";
  error: string | null;
  converged: boolean | null;
  newStaleChapterIds: number[];
  skippedNoNote: number;
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
  affectedCount?: number;
  affectedListUnavailable?: boolean;
  isFirstAnalysis: boolean;
  unchanged?: boolean;
  noopReason?: string;
  foreshadowings: ForeshadowingSummaryItem[];
  entities: EntitySummaryItem[];
  foreshadowingsError?: boolean;
  entitiesError?: boolean;
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
  let didResize = false;

  const onMove = (ev: MouseEvent): void => {
    didResize = true;
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
    // 点了一下没拖动：恢复默认尺寸，避免残留 user-resized class 让列表永久展开。
    if (!didResize) {
      modalEl.setCssProps({ width: "", height: "" });
      modalEl.removeClass("penseed-user-resized");
    }
  };

  handle.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    startX = ev.clientX;
    startY = ev.clientY;
    startWidth = modalEl.offsetWidth;
    startHeight = modalEl.offsetHeight;
    didResize = false;
    // 先钉住当前尺寸再加 class：.penseed-user-resized 会把 max-height:80vh 和
    // 列表 max-height:12em 都改成 none，若 addClass 前不固定内联尺寸，mousedown
    // 瞬间 modal 就跳到内容自然高度；手滑松手后更会卡死在视口外、无法再操作。
    modalEl.style.width = `${startWidth}px`;
    modalEl.style.height = `${startHeight}px`;
    modalEl.addClass("penseed-user-resized");
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
    this.modalEl.addClass("penseed-result-modal");
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
      const wordingOnly =
        this.summary.noopReason === "semantic unchanged (wording-only)";
      const notice = contentEl.createDiv({
        text: wordingOnly
          ? "Only your wording changed — the meaning is unchanged, so Penseed skipped the full re-run. No downstream chapters are affected: your story is consistent, safe to continue."
          : "This chapter hasn't changed since your last analysis, so Penseed skipped the re-run. Your notes are already up to date — no credits were used, and no downstream chapters are affected.",
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

    if (this.summary.foreshadowingsError) {
      const hint = contentEl.createDiv({
        text: "Couldn't load this chapter's foreshadowings. Open the web app to review them.",
      });
      hint.addClass("penseed-manage-notice");
    }

    if (this.summary.foreshadowings.length > 0) {
      contentEl.createEl("h3", { text: "Foreshadowings" });
      const fsList = contentEl.createEl("ul");
      fsList.addClass("penseed-item-list");
      fsList.addClass("penseed-grow");
      for (const f of this.summary.foreshadowings) {
        const li = fsList.createEl("li");
        li.addClass("penseed-item-row");
        li.createSpan({ text: f.text || "(untitled)" });
        if (f.status) {
          li.createSpan({ text: f.status, cls: "penseed-status-tag" });
        }
      }
    }

    if (this.summary.entitiesError) {
      const hint = contentEl.createDiv({
        text: "Couldn't load this chapter's elements. Open the web app to review them.",
      });
      hint.addClass("penseed-manage-notice");
    }

    if (this.summary.entities.length > 0) {
      contentEl.createEl("h3", { text: "Elements" });
      const entList = contentEl.createEl("ul");
      entList.addClass("penseed-item-list");
      entList.addClass("penseed-item-list-horizontal");
      for (const e of this.summary.entities) {
        const li = entList.createEl("li");
        li.addClass("penseed-item-pill");
        li.createSpan({ text: e.name });
        if (e.type) {
          li.createSpan({ text: e.type, cls: "penseed-status-tag" });
        }
      }
    }

    const affectedCount =
      this.summary.affectedCount ?? this.summary.affected.length;
    if (affectedCount > 0) {
      contentEl
        .createDiv({
          text: `${affectedCount} downstream chapter${plural(
            affectedCount
          )} affected`,
        })
        .addClass("penseed-cta-label");

      // Read-only list of affected chapters. Individual per-row "re-analyze" is
      // deliberately removed: re-analyzing a single stale chapter out of order
      // corrupts downstream state (cascade/butterfly effect). The only action is
      // one batch button that re-analyzes the whole set in chapter order.
      // When the chapter-number mapping couldn't be fetched, we degrade to a
      // count-only summary rather than showing misleading raw ids.
      if (!this.summary.affectedListUnavailable) {
        const list = contentEl.createEl("ul");
        list.addClass("penseed-item-list");
        list.addClass("penseed-grow");
        for (const item of this.summary.affected) {
          const li = list.createEl("li");
          li.addClass("penseed-item-row");
          const label = item.noteTitle
            ? `Chapter ${item.chapterNumber} — ${item.noteTitle}`
            : `Chapter ${item.chapterNumber} — note not found`;
          li.createSpan({ text: label });
        }
      }

      if (this.summary.onBatchReplay) {
        this.renderBatchReplay(contentEl);
      }
    } else if (!this.summary.unchanged) {
      // Phase 0.22-11: a real re-analysis that found no downstream impact. Give
      // the author an explicit all-clear instead of a silent omission.
      contentEl
        .createDiv({
          text: "No downstream chapters are affected — your story is consistent, safe to continue.",
        })
        .addClass("penseed-unchanged-notice");
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
          notify(
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
    this.modalEl.addClass("penseed-result-modal");
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

    const body = contentEl.createDiv({ cls: "penseed-batch-body" });

    if (state.status === "running") {
      const total = state.total || 0;
      const completed = state.completed || 0;
      body.createDiv({
        cls: "penseed-batch-status",
        text: `Re-analyzing ${completed}/${total}`,
      });

      const meta = body.createDiv({ cls: "penseed-batch-meta" });
      if (state.currentChapterNumber != null) {
        meta.createDiv({
          cls: "penseed-batch-tag",
          text: `Chapter ${state.currentChapterNumber}`,
        });
      }
      if (state.failed > 0) {
        meta.createDiv({ cls: "penseed-batch-tag", text: `${state.failed} failed` });
      }
    } else if (state.status === "completed") {
      body.createDiv({
        cls: "penseed-batch-status",
        text: `${state.completed} chapter${plural(state.completed)} re-analyzed`,
      });

      const meta = body.createDiv({ cls: "penseed-batch-meta" });
      if (state.skippedNoNote > 0) {
        meta.createDiv({
          cls: "penseed-batch-tag",
          text: `${state.skippedNoNote} skipped (no local note)`,
        });
      }
      if (state.failed > 0) {
        meta.createDiv({ cls: "penseed-batch-tag", text: `${state.failed} failed` });
      }

      if (state.converged === false && state.newStaleChapterIds.length > 0) {
        body.createDiv({
          cls: "penseed-batch-detail",
          text: `${state.newStaleChapterIds.length} more chapter${plural(
            state.newStaleChapterIds.length
          )} now out of date — open Penseed to continue.`,
        });
      }
    } else if (state.status === "error") {
      body.createDiv({
        cls: "penseed-batch-detail",
        text: state.error || "Batch re-analysis failed.",
      });
    } else {
      body.createDiv({
        cls: "penseed-batch-detail",
        text: "Batch re-analysis cancelled.",
      });
    }

    if (state.status === "running" && this.onCancel) {
      const footer = contentEl.createDiv({ cls: "penseed-batch-footer" });
      const cancel = footer.createEl("button", { text: "Cancel" });
      cancel.addClass("penseed-batch-button");
      cancel.addEventListener("click", () => {
        void this.onCancel!();
      });
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
