import { App, Modal } from "obsidian";
import { ApiError, BatchSyncPreview, PendingFanout } from "./api";
import { notify } from "./notify";
import type { StaleDisplayItem } from "./stale";
import type { ClassifiedFile } from "./chapterClassifier";

export interface ReplayItem {
  chapterNumber: number;
  noteTitle: string | null;
}

export interface ReanalysisBatchTaskState {
  taskId: string;
  projectId: number;
  projectTitle: string | null;
  total: number;
  completed: number;
  failed: number;
  currentChapterNumber: number | null;
  status: "running" | "paused" | "completed" | "error" | "cancelled";
  error: string | null;
  converged: boolean | null;
  newStaleChapterIds: number[];
  skippedNoNote: number;
  // Phase 0.55: 级联富结果（仅整本同步路径提供）。
  currentWave: number | null;
  totalWaves: number | null;
  stoppedByLimit: boolean | null;
  stoppedReason: "converged" | "limit" | "no_content" | "cancelled" | null;
  remainingStaleCount: number | null;
  // Phase 0.55: 大扇出暂停决策态。
  pauseReason: "fanout" | "rate_limit" | null;
  pendingFanout: PendingFanout | null;
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
  private onResume: (() => Promise<void>) | null;
  private onStop: (() => Promise<void>) | null;
  private interval: number | null = null;
  private resizeCleanup: (() => void) | null = null;

  constructor(
    app: App,
    getState: () => ReanalysisBatchTaskState | null,
    onCancel: (() => Promise<void>) | null = null,
    onResume: (() => Promise<void>) | null = null,
    onStop: (() => Promise<void>) | null = null
  ) {
    super(app);
    this.getState = getState;
    this.onCancel = onCancel;
    this.onResume = onResume;
    this.onStop = onStop;
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

    if (state.projectTitle) {
      contentEl.createDiv({
        cls: "penseed-batch-project",
        text: `Project: ${state.projectTitle}`,
      });
    }

    const body = contentEl.createDiv({ cls: "penseed-batch-body" });

    if (state.status === "running") {
      const total = state.total || 0;
      const completed = state.completed || 0;
      // 级联（第 2+ 波）时 completed 会累计跨波次超过 total，此时只显示波次，
      // 避免出现「18/16」这类令用户困惑的分数（用户只贴入了 total 章）。
      const runningText =
        state.currentWave != null && state.currentWave > 1
          ? `Re-analyzing wave ${state.currentWave}…`
          : `Re-analyzing ${completed}/${total}`;
      body.createDiv({
        cls: "penseed-batch-status",
        text: runningText,
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
      const total = state.total || 0;
      const completed = state.completed || 0;
      // 级联跨波次时 completed 累计值（如 19）会超过用户实际提交的章数（如 16），
      // 这里回退到 total，避免「19 chapters」这类困惑；单波次仍用 completed 以保留失败统计。
      const didCascade = (state.totalWaves ?? 1) > 1;
      const analyzedCount = didCascade ? total : completed;
      body.createDiv({
        cls: "penseed-batch-status",
        text: `${analyzedCount} chapter${plural(analyzedCount)} analyzed`,
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

      if (state.stoppedReason === "limit") {
        body.createDiv({
          cls: "penseed-batch-detail",
          text: `Stopped at the safety limit after ${
            state.totalWaves ?? 1
          } wave${plural(state.totalWaves ?? 1)} — ${
            state.remainingStaleCount ?? 0
          } chapters still need review.`,
        });
      } else if (state.stoppedReason === "no_content") {
        body.createDiv({
          cls: "penseed-batch-detail",
          text: `Sync done, but ${
            state.remainingStaleCount ?? 0
          } chapters are still outdated — re-paste their text to finish.`,
        });
      } else if (state.stoppedReason === "converged") {
        body.createDiv({
          cls: "penseed-batch-detail",
          text: `Converged after ${state.totalWaves ?? 1} wave${plural(
            state.totalWaves ?? 1
          )} — all chapters are up to date.`,
        });
      } else if (state.converged === false && state.newStaleChapterIds.length > 0) {
        body.createDiv({
          cls: "penseed-batch-detail",
          text: `${state.newStaleChapterIds.length} more chapter${plural(
            state.newStaleChapterIds.length
          )} are now out of date.`,
        });
      }
    } else if (state.status === "error") {
      body.createDiv({
        cls: "penseed-batch-detail",
        text: state.error || "Batch re-analysis failed.",
      });
    } else if (state.status === "paused") {
      const count =
        state.pendingFanout?.chapter_count ??
        state.pendingFanout?.chapter_ids?.length ??
        0;
      body.createDiv({
        cls: "penseed-batch-status",
        text: `Large re-analysis — ${count} downstream chapter${plural(count)}`,
      });
      body.createDiv({
        cls: "penseed-batch-detail",
        text: `This edit affects about ${count} downstream chapter${plural(
          count
        )}. Continue to re-analyze them all, or stop here?`,
      });

      if (this.onStop || this.onResume) {
        const footer = contentEl.createDiv({ cls: "penseed-batch-footer" });
        if (this.onStop) {
          const stop = footer.createEl("button", { text: "Stop here" });
          stop.addClass("penseed-batch-button");
          stop.addEventListener("click", () => {
            void this.onStop!();
          });
        }
        if (this.onResume) {
          const cont = footer.createEl("button", {
            text: `Continue (${count} chapters)`,
          });
          cont.addClass("penseed-batch-button");
          cont.addClass("penseed-batch-button-primary");
          cont.addEventListener("click", () => {
            void this.onResume!();
          });
        }
      }
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

export class OutdatedChaptersModal extends Modal {
  private items: StaleDisplayItem[];
  private onBatchReanalyze: () => Promise<void>;
  private resizeCleanup: (() => void) | null = null;

  constructor(
    app: App,
    items: StaleDisplayItem[],
    onBatchReanalyze: () => Promise<void>
  ) {
    super(app);
    this.items = items;
    this.onBatchReanalyze = onBatchReanalyze;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("penseed-result-modal");
    contentEl.addClass("penseed-result");
    this.resizeCleanup = installModalResize(this);

    const count = this.items.length;
    contentEl.createEl("h2", {
      text: `${count} outdated chapter${count === 1 ? "" : "s"}`,
    });

    const hint = contentEl.createDiv({
      text: "These chapters are out of date because an earlier chapter changed. Re-analyze them in order to keep your story consistent.",
    });
    hint.addClass("penseed-unchanged-notice");

    const list = contentEl.createEl("ul");
    list.addClass("penseed-item-list");
    list.addClass("penseed-grow");
    for (const item of this.items) {
      const li = list.createEl("li");
      li.addClass("penseed-item-row");
      const label =
        item.chapterNumber !== null
          ? item.noteTitle
            ? `Chapter ${item.chapterNumber} — ${item.noteTitle}`
            : `Chapter ${item.chapterNumber} — note not found`
          : "Chapter (unnumbered)";
      li.createSpan({ text: label });
    }

    const button = contentEl.createEl("button", {
      text: "Batch re-analyze outdated chapters",
    });
    button.addClass("mod-cta");
    button.addClass("penseed-batch-button");
    button.addEventListener("click", () => {
      void (async () => {
        button.disabled = true;
        button.setText("Submitting…");
        try {
          await this.onBatchReanalyze();
          this.close();
        } catch (e) {
          button.disabled = false;
          button.setText("Batch re-analyze failed — retry");
          notify(
            e instanceof ApiError
              ? e.userMessage
              : "Batch re-analysis failed. Check the Penseed web app for details."
          );
          console.error("[Penseed] Batch re-analysis from outdated badge failed", e);
        }
      })();
    });
  }

  onClose(): void {
    this.resizeCleanup?.();
    this.resizeCleanup = null;
    this.contentEl.empty();
  }
}

export interface ClassificationResult {
  includedPaths: Set<string>;
  persistExcludes: string[];
}

function classificationReason(f: ClassifiedFile): string {
  if (f.number !== null) return "numbered";
  if (f.defaultInclude) return "front matter";
  return "no number — likely a note";
}

/**
 * Phase 0.37 confirmation gate D: language-independent classification preview.
 * Chapters (auto) are pre-selected and editable; "needs-confirm" notes are
 * checkboxes preset to the classifier's defaultInclude; excluded notes default
 * unchecked but stay editable so the author can override the classifier.
 * A "remember excluded notes" checkbox persists the note-exclusion list
 * (scheme C) — chapters are never persisted as excluded.
 */
export class ClassificationModal extends Modal {
  private classified: ClassifiedFile[];
  private resolve: (result: ClassificationResult | null) => void;
  private settled = false;
  private checks = new Map<string, HTMLInputElement>();
  private rememberBox: HTMLInputElement | null = null;
  private resizeCleanup: (() => void) | null = null;

  constructor(
    app: App,
    classified: ClassifiedFile[],
    resolve: (result: ClassificationResult | null) => void
  ) {
    super(app);
    this.classified = classified;
    this.resolve = resolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("penseed-result-modal");
    this.modalEl.addClass("penseed-manuscript-modal");
    contentEl.addClass("penseed-result");

    contentEl.createEl("h2", { text: "Sync whole manuscript" });

    // 功能介绍：是什么 / 好处 / 威力 / 省 token / 哪些章会被分析。
    const intro = contentEl.createDiv({ cls: "penseed-manuscript-intro" });
    intro.createDiv({
      text: "Sync your whole manuscript in one pass. Penseed reads the notes in this project's folder and, for every chapter, extracts:",
    });
    const bullets = intro.createEl("ul");
    bullets.createEl("li", {
      text: "Foreshadowings — every plant and payoff, tracked across chapters.",
    });
    bullets.createEl("li", {
      text: "Elements — characters, objects, and places, checked book-wide for consistency.",
    });
    bullets.createEl("li", {
      text: "Resolutions — how each plot thread develops and resolves.",
    });

    // 省 token：未改章节（hash 命中且非 stale）零 token 跳过，配额只按 new + changed 计。
    const saving = contentEl.createDiv();
    saving.addClass("penseed-unchanged-notice");
    saving.createDiv({
      text: "Pay only for what changed",
      cls: "penseed-warning-title",
    });
    saving.createDiv({
      text: "Penseed compares each chapter against your last analysis and skips unchanged chapters automatically — you only spend AI credits on chapters that are new or have actually changed. The next screen shows the exact count and estimated credits before anything runs.",
    });

    // 哪些章会被分析 / 不会被分析。
    const hint = contentEl.createDiv({
      text: `Chapters (auto) are pre-selected and will be analyzed — uncheck any to skip. Under "Review these notes", tick notes that are real chapters. "Excluded" notes are left out by default, but you can tick them to include them anyway.`,
    });
    hint.addClass("penseed-unchanged-notice");

    // 按章节号升序展示（无编号参考 note 排最后，按 basename 字典序），
    // 避免 getMarkdownFiles() 的 vault 枚举顺序导致章节乱序。
    // 主键按章节号升序（纯数字减法，语言无关）；无编号参考 note 之间按
    // code-unit 字典序比较（< / >），避免 localeCompare 依赖运行环境 locale。
    const byNumber = (a: ClassifiedFile, b: ClassifiedFile) =>
      (a.number ?? Number.MAX_SAFE_INTEGER) -
        (b.number ?? Number.MAX_SAFE_INTEGER) ||
      (a.basename < b.basename ? -1 : a.basename > b.basename ? 1 : 0);
    const chapters = this.classified
      .filter((f) => f.verdict === "chapter")
      .sort(byNumber);
    const review = this.classified
      .filter((f) => f.verdict === "needs-confirm")
      .sort(byNumber);
    const excluded = this.classified
      .filter((f) => f.verdict === "excluded")
      .sort(byNumber);

    // 有 excluded 时才解释为何排除：防止剧透 + 非正文 + 稀疏文件夹自动识别 + 历史排除。
    if (excluded.length > 0) {
      const whyExcluded = contentEl.createDiv({ cls: "penseed-manuscript-excluded" });
      whyExcluded.createDiv({
        text: "Why notes are excluded",
        cls: "penseed-warning-title",
      });
      whyExcluded.createDiv({
        text: "These are usually planning material, not story chapters — character sheets, world bibles, plot outlines. Penseed keeps them out so spoilers don't leak into your analysis, because they often reveal twists the reader shouldn't know yet. It also auto-detects sparse subfolders as likely reference material and remembers notes you've excluded before. If it got one wrong, tick it to include it anyway.",
      });
    }

    const list = contentEl.createEl("ul");
    list.addClass("penseed-item-list");
    list.addClass("penseed-grow");

    if (chapters.length > 0) {
      this.renderGroup(list, "Chapters (auto)", chapters, true);
    }
    if (review.length > 0) {
      this.renderGroup(list, "Review these notes", review, true, false, true);
    }
    if (excluded.length > 0) {
      this.renderGroup(list, "Excluded", excluded, true, true);
    }

    const rememberRow = contentEl.createDiv({ cls: "penseed-confirm-actions" });
    const rememberLabel = rememberRow.createEl("label");
    this.rememberBox = rememberLabel.createEl("input", { type: "checkbox" });
    rememberLabel.appendText(" Remember excluded notes for future syncs");

    const actions = contentEl.createDiv({ cls: "penseed-confirm-actions" });
    const syncBtn = actions.createEl("button", { text: "Sync", cls: "mod-cta" });
    syncBtn.addEventListener("click", () => this.settle());
    const cancelBtn = actions.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.settleCancel());

    this.resizeCleanup = installModalResize(this);
  }

  private renderGroup(
    list: HTMLElement,
    title: string,
    files: ClassifiedFile[],
    editable: boolean,
    muted = false,
    showReason = false
  ): void {
    const header = list.createEl("li");
    header.addClass("penseed-item-row");
    header.createSpan({ text: title, cls: "penseed-batch-tag" });

    for (const f of files) {
      const li = list.createEl("li");
      li.addClass("penseed-item-row");
      if (muted) li.addClass("penseed-excluded-row");

      const label = li.createEl("label");
      const box = label.createEl("input", { type: "checkbox" });
      this.checks.set(f.path, box);
      box.checked = f.defaultInclude;
      box.disabled = !editable;

      const text = label.createSpan();
      text.setText(f.basename);
      if (showReason) {
        const reason = label.createSpan({ cls: "penseed-batch-tag" });
        reason.setText(` (${classificationReason(f)})`);
      }
    }
  }

  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    const includedPaths = new Set<string>();
    // 「记住排除」只针对 reference note（needs-confirm / excluded），
    // 用户临时取消勾选的章节只跳过本次同步，不永久排除。
    const excludedNotes: string[] = [];
    for (const f of this.classified) {
      const box = this.checks.get(f.path);
      if (box?.checked) {
        includedPaths.add(f.path);
      } else if (f.verdict !== "chapter") {
        excludedNotes.push(f.path);
      }
    }
    const persistExcludes = this.rememberBox?.checked ? excludedNotes : [];
    this.resolve({ includedPaths, persistExcludes });
    this.close();
  }

  private settleCancel(): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(null);
    this.close();
  }

  onClose(): void {
    this.resizeCleanup?.();
    this.resizeCleanup = null;
    if (!this.settled) {
      this.settled = true;
      this.resolve(null);
    }
    this.contentEl.empty();
  }
}

/**
 * Phase 0.37: pre-start preview of the bulk-sync diff (new/unchanged/changed +
 * estimated credits + drift note). Confirm to start, cancel to abort the job.
 */
export class SyncPreviewModal extends Modal {
  private preview: BatchSyncPreview;
  private resolve: (ok: boolean) => void;
  private settled = false;

  constructor(
    app: App,
    preview: BatchSyncPreview,
    resolve: (ok: boolean) => void
  ) {
    super(app);
    this.preview = preview;
    this.resolve = resolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("penseed-confirm");

    contentEl.createEl("h2", { text: "Start sync?" });

    const p = this.preview;
    const summary = contentEl.createDiv({ cls: "penseed-batch-meta" });
    summary.createDiv({
      cls: "penseed-batch-tag",
      text: `${p.new} new`,
    });
    summary.createDiv({
      cls: "penseed-batch-tag",
      text: `${p.unchanged} unchanged`,
    });
    summary.createDiv({
      cls: "penseed-batch-tag",
      text: `${p.changed} changed`,
    });
    if (p.missing_in_project > 0) {
      summary.createDiv({
        cls: "penseed-batch-tag",
        text: `${p.missing_in_project} missing in project`,
      });
    }

    contentEl.createDiv({
      text: `Estimated cost: ${p.estimated_credits} credits.`,
    });

    if (p.drift_detected) {
      const drift = contentEl.createDiv({
        text: p.drift_note || "Chapter numbering may have drifted.",
      });
      drift.addClass("penseed-unchanged-notice");
    }

    const actions = contentEl.createDiv({ cls: "penseed-confirm-actions" });
    const startBtn = actions.createEl("button", {
      text: "Start sync",
      cls: "mod-cta",
    });
    startBtn.addEventListener("click", () => this.settle(true));
    const cancelBtn = actions.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.settle(false));
  }

  private settle(ok: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(ok);
    this.close();
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.resolve(false);
    }
    this.contentEl.empty();
  }
}
