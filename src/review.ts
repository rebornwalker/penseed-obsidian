import { App, Modal, Notice } from "obsidian";
import { ApiError, ForeshadowingCandidate } from "./api";

function truncate(text: string | null | undefined, max = 80): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max).trimEnd() + "…" : text;
}

function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.userMessage : "Please try again later.";
}

export interface ReviewEntity {
  name: string;
  type?: string;
  aliases?: string[];
  attributes?: Record<string, unknown>;
  description?: string;
}

export interface ReviewResolvedItem {
  id: number;
  text: string;
  confidence: number | null;
  resolutionType: string | null;
  evidence: string | null;
}

export interface ReviewChapterSummary {
  revelations?: string[];
  resolutions?: string[];
  plot_advances?: string[];
  key_entities?: string[];
}

export interface ReviewSelection {
  candidates: ForeshadowingCandidate[];
  entities: ReviewEntity[];
  resolvedIds: number[];
}

export interface AnalysisReviewData {
  projectId: number;
  chapterId: number;
  chapterNumber: number | null;
  candidates: ForeshadowingCandidate[];
  entities: ReviewEntity[];
  resolvedItems: ReviewResolvedItem[];
  summary: ReviewChapterSummary | null;
  onSave: (selection: ReviewSelection) => Promise<void>;
}

/**
 * Phase 0.14: review-and-select modal for a newly analyzed chapter. Mirrors the
 * web app's "extract → review → save" flow: candidates and entities come back
 * uncommitted, are pre-selected, and Save persists only what stays selected.
 * Progress records are intentionally web-only (differentiation + funnel).
 */
export class AnalysisReviewModal extends Modal {
  private data: AnalysisReviewData;
  private selectedCandidates = new Set<number>();
  private selectedEntities = new Set<number>();
  private selectedResolved = new Set<number>();
  private saving = false;
  private tooltipEl: HTMLElement | null = null;
  private resizeCleanup: (() => void) | null = null;

  constructor(app: App, data: AnalysisReviewData) {
    super(app);
    this.data = data;
    data.candidates.forEach((_, i) => this.selectedCandidates.add(i));
    data.entities.forEach((_, i) => this.selectedEntities.add(i));
    data.resolvedItems.forEach((item) => this.selectedResolved.add(item.id));
  }

  onOpen(): void {
    this.modalEl.addClass("penseed-review-modal");
    this.render();
    this.installResizeHandle();
  }

  onClose(): void {
    this.resizeCleanup?.();
    this.resizeCleanup = null;
    this.hideTooltip();
    this.tooltipEl?.remove();
    this.tooltipEl = null;
    this.contentEl.empty();
  }

  private installResizeHandle(): void {
    const modal = this.modalEl;
    const handle = modal.createDiv({ cls: "penseed-resize-handle" });

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
      modal.style.width = `${width}px`;
      modal.style.height = `${height}px`;
    };

    const stop = (): void => {
      document.body.classList.remove("penseed-resizing");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", stop);
    };
    this.resizeCleanup = stop;

    handle.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      startX = ev.clientX;
      startY = ev.clientY;
      startWidth = modal.offsetWidth;
      startHeight = modal.offsetHeight;
      document.body.classList.add("penseed-resizing");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", stop);
    });
  }

  private render(): void {
    const { contentEl } = this;
    this.hideTooltip();
    contentEl.empty();
    contentEl.addClass("penseed-review");

    contentEl.createEl("h2", { text: "Analysis Results" });

    if (this.data.summary) {
      this.renderSummary(contentEl, this.data.summary);
    }

    const body = contentEl.createDiv({ cls: "penseed-review-body" });

    if (this.data.candidates.length > 0) {
      this.renderCandidates(body);
    }
    if (this.data.entities.length > 0) {
      this.renderEntities(body);
    }
    if (this.data.resolvedItems.length > 0) {
      this.renderResolved(body);
    }

    if (
      this.data.candidates.length === 0 &&
      this.data.entities.length === 0 &&
      this.data.resolvedItems.length === 0
    ) {
      body.createDiv({
        cls: "penseed-review-empty",
        text: "No foreshadowing or elements found in this chapter.",
      });
    }

    this.renderFooter(contentEl);
  }

  private refresh(): void {
    this.render();
  }

  private renderSummary(parent: HTMLElement, summary: ReviewChapterSummary): void {
    const box = parent.createDiv({ cls: "penseed-review-summary" });
    box.createDiv({
      cls: "penseed-review-summary-title",
      text: "Chapter Analysis Summary",
    });

    const parts: Array<[string, string[] | undefined, boolean]> = [
      ["Revelations", summary.revelations, false],
      ["Resolutions", summary.resolutions, false],
      ["Plot Advances", summary.plot_advances, false],
      ["Key Elements", summary.key_entities, true],
    ];

    for (const [label, items, horizontal] of parts) {
      if (!items || items.length === 0) continue;
      const details = box.createEl("details", { cls: "penseed-review-details" });
      details.createEl("summary", { text: `${label} (${items.length})` });
      const ul = details.createEl("ul");
      if (horizontal) ul.addClass("penseed-review-summary-tags");
      for (const item of items) {
        ul.createEl("li", { text: item });
      }
    }
  }

  private renderSectionHeader(
    parent: HTMLElement,
    title: string,
    selectedCount: number,
    totalCount: number,
    onSelectAll: () => void,
    onDeselectAll: () => void
  ): void {
    const header = parent.createDiv({ cls: "penseed-review-section-header" });
    const heading = header.createDiv({ cls: "penseed-review-section-heading" });
    heading.createSpan({ cls: "penseed-review-section-title", text: title });
    heading.createSpan({
      cls: "penseed-review-section-count",
      text: `${selectedCount} of ${totalCount} selected`,
    });

    const actions = header.createDiv({ cls: "penseed-review-section-actions" });
    const selectAll = actions.createEl("button", { text: "Select All" });
    selectAll.addEventListener("click", onSelectAll);
    const deselectAll = actions.createEl("button", { text: "Deselect All" });
    deselectAll.addEventListener("click", onDeselectAll);
  }

  private renderCandidates(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "penseed-review-section" });
    this.renderSectionHeader(
      section,
      "New Foreshadowing",
      this.selectedCandidates.size,
      this.data.candidates.length,
      () => {
        this.data.candidates.forEach((_, i) => this.selectedCandidates.add(i));
        this.refresh();
      },
      () => {
        this.selectedCandidates.clear();
        this.refresh();
      }
    );

    const list = section.createDiv({ cls: "penseed-review-list" });
    this.data.candidates.forEach((candidate, index) => {
      const text = candidate.foreshadowing_text_preview ?? candidate.text ?? "";
      const badges: string[] = [];
      if (typeof candidate.confidence === "number") {
        badges.push(`${Math.round(candidate.confidence * 100)}%`);
      }
      if (candidate.foreshadowing_type) {
        badges.push(candidate.foreshadowing_type);
      }
      this.renderRow(list, {
        checked: this.selectedCandidates.has(index),
        text,
        badges,
        onToggle: () => {
          if (this.selectedCandidates.has(index)) {
            this.selectedCandidates.delete(index);
          } else {
            this.selectedCandidates.add(index);
          }
          this.refresh();
        },
      });
    });
  }

  private renderEntities(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "penseed-review-section" });
    this.renderSectionHeader(
      section,
      "Elements",
      this.selectedEntities.size,
      this.data.entities.length,
      () => {
        this.data.entities.forEach((_, i) => this.selectedEntities.add(i));
        this.refresh();
      },
      () => {
        this.selectedEntities.clear();
        this.refresh();
      }
    );

    const list = section.createDiv({
      cls: "penseed-review-list penseed-review-list-horizontal",
    });
    this.data.entities.forEach((entity, index) => {
      this.renderRow(list, {
        checked: this.selectedEntities.has(index),
        text: entity.name,
        badges: entity.type ? [entity.type] : [],
        onToggle: () => {
          if (this.selectedEntities.has(index)) {
            this.selectedEntities.delete(index);
          } else {
            this.selectedEntities.add(index);
          }
          this.refresh();
        },
      });
    });
  }

  private renderResolved(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: "penseed-review-section" });
    this.renderSectionHeader(
      section,
      "Resolved Foreshadowing",
      this.selectedResolved.size,
      this.data.resolvedItems.length,
      () => {
        this.data.resolvedItems.forEach((item) =>
          this.selectedResolved.add(item.id)
        );
        this.refresh();
      },
      () => {
        this.selectedResolved.clear();
        this.refresh();
      }
    );

    const list = section.createDiv({ cls: "penseed-review-list" });
    this.data.resolvedItems.forEach((item) => {
      const badges: string[] = [];
      if (item.resolutionType) badges.push(item.resolutionType);
      if (typeof item.confidence === "number") {
        badges.push(`${Math.round(item.confidence * 100)}%`);
      }
      this.renderRow(list, {
        checked: this.selectedResolved.has(item.id),
        text: item.text,
        badges,
        onToggle: () => {
          if (this.selectedResolved.has(item.id)) {
            this.selectedResolved.delete(item.id);
          } else {
            this.selectedResolved.add(item.id);
          }
          this.refresh();
        },
      });
    });
  }

  private renderRow(
    list: HTMLElement,
    opts: { checked: boolean; text: string; badges: string[]; onToggle: () => void }
  ): void {
    // A <label> makes the whole row toggle the checkbox natively (no manual
    // click handling), so clicking the text or badge also flips the selection.
    const label = list.createEl("label", { cls: "penseed-review-row" });
    const checkbox = label.createEl("input", { type: "checkbox" });
    checkbox.checked = opts.checked;
    checkbox.addEventListener("change", opts.onToggle);

    const body = label.createDiv({ cls: "penseed-review-row-body" });
    const textEl = body.createDiv({
      cls: "penseed-review-row-text",
      text: truncate(opts.text),
    });
    for (const badge of opts.badges) {
      body.createSpan({ cls: "penseed-review-badge", text: badge });
    }

    if (opts.text.length > 80) {
      textEl.addEventListener("mouseenter", () =>
        this.showTooltip(opts.text, textEl)
      );
      textEl.addEventListener("mouseleave", () => this.hideTooltip());
    }
  }

  private renderFooter(parent: HTMLElement): void {
    const footer = parent.createDiv({ cls: "penseed-review-footer" });

    const parts: string[] = [];
    if (this.selectedCandidates.size > 0) {
      parts.push(`${this.selectedCandidates.size} foreshadowing`);
    }
    if (this.selectedEntities.size > 0) {
      parts.push(`${this.selectedEntities.size} elements`);
    }
    if (this.selectedResolved.size > 0) {
      parts.push(`${this.selectedResolved.size} resolved`);
    }
    footer.createDiv({
      cls: "penseed-review-footer-summary",
      text: parts.length > 0 ? parts.join(" · ") : "Nothing selected",
    });

    const actions = footer.createDiv({ cls: "penseed-review-footer-actions" });
    const cancelBtn = actions.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const saveBtn = actions.createEl("button", { text: "Save", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => void this.handleSave(saveBtn));
  }

  private async handleSave(saveBtn: HTMLButtonElement): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";

    const selection: ReviewSelection = {
      candidates: this.data.candidates.filter((_, i) =>
        this.selectedCandidates.has(i)
      ),
      entities: this.data.entities.filter((_, i) => this.selectedEntities.has(i)),
      resolvedIds: this.data.resolvedItems
        .filter((item) => this.selectedResolved.has(item.id))
        .map((item) => item.id),
    };

    try {
      await this.data.onSave(selection);
      this.close();
    } catch (e) {
      new Notice(errorMessage(e));
      this.saving = false;
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }
  }

  private showTooltip(text: string, anchor: HTMLElement): void {
    if (!this.tooltipEl) {
      this.tooltipEl = document.body.createDiv({ cls: "penseed-card-tooltip" });
    }
    const tooltip = this.tooltipEl;
    tooltip.textContent = text;
    tooltip.removeClass("is-visible");
    if (!tooltip.isConnected) document.body.appendChild(tooltip);

    const rect = anchor.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();

    let left = rect.right - tipRect.width;
    left = Math.max(8, left);
    let top = rect.top;
    top = Math.min(top, window.innerHeight - tipRect.height - 8);
    top = Math.max(8, top);

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    tooltip.addClass("is-visible");
  }

  private hideTooltip(): void {
    this.tooltipEl?.removeClass("is-visible");
  }
}
