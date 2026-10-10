import { ItemView, WorkspaceLeaf, MarkdownView, TFile, setIcon } from "obsidian";
import type PenseedPlugin from "./main";
import { notify } from "./notify";
import { extractChapterNumber } from "./chapter";
import {
  ApiError,
  listProjects,
  listForeshadowingsByProject,
  updateForeshadowingStatus,
  ForeshadowingItem,
  ForeshadowingListByProjectResult,
  PenseedProject,
} from "./api";

export const VIEW_TYPE_FORESHADOWING_BOARD = "penseed-foreshadowing-board";

const COLUMNS: Array<{ status: string; label: string }> = [
  { status: "pending", label: "Pending" },
  { status: "in_progress", label: "In Progress" },
  { status: "resolved", label: "Resolved" },
  { status: "cancelled", label: "Cancelled" },
];

function truncate(text: string | null | undefined, max = 80): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max).trimEnd() + "…" : text;
}

function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.userMessage : "Please try again later.";
}

/**
 * Normalize a string for fuzzy matching: keep only letters and digits,
 * lowercase them, and record each kept character's original index so a match
 * in the normalized string can be mapped back to exact source offsets.
 */
function normalizeForMatch(text: string): {
  normalized: string;
  indices: number[];
} {
  const normalized: string[] = [];
  const indices: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!/[\p{L}\p{N}]/u.test(ch)) continue;
    normalized.push(ch.toLowerCase());
    indices.push(i);
  }
  return { normalized: normalized.join(""), indices };
}

/**
 * Locate `needle` in `content`, returning the exact [from, to) source offsets.
 * Tries, in order: exact match, case-insensitive match, normalized fuzzy match
 * (ignoring whitespace/punctuation/case), then a longest-word token anchor.
 * Returns null only when nothing plausible matches.
 */
function locateMatch(
  content: string,
  needle: string
): { from: number; to: number } | null {
  if (!needle || !content) return null;

  let offset = content.indexOf(needle);
  if (offset !== -1) return { from: offset, to: offset + needle.length };

  offset = content.toLowerCase().indexOf(needle.toLowerCase());
  if (offset !== -1) return { from: offset, to: offset + needle.length };

  const haystack = normalizeForMatch(content);
  const query = normalizeForMatch(needle);

  // Guard against overly short normalized needles, which would match
  // spuriously all over a long chapter.
  if (query.normalized.length >= 6) {
    const normOffset = haystack.normalized.indexOf(query.normalized);
    if (normOffset !== -1) {
      return {
        from: haystack.indices[normOffset],
        to: haystack.indices[normOffset + query.normalized.length - 1] + 1,
      };
    }
  }

  // Token-anchor fallback: hop to the longest distinctive word in the preview.
  const tokens = (needle.match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length >= 4)
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  for (const token of tokens) {
    const tokenQuery = normalizeForMatch(token);
    const pos = haystack.normalized.indexOf(tokenQuery.normalized);
    if (pos !== -1) {
      return {
        from: haystack.indices[pos],
        to: haystack.indices[pos + tokenQuery.normalized.length - 1] + 1,
      };
    }
  }

  return null;
}

/**
 * Phase 0.13: a simplified kanban board in the plugin. It reuses the web board's
 * exact endpoints (`GET /api/foreshadowing/?project_id=` + `PUT /api/foreshadowing/{id}`),
 * so the backend `status` field is the single source of truth and both ends stay
 * in sync. Cards show only the preview + priority + chapter; complex operations
 * stay on the web app.
 */
export class ForeshadowingBoardView extends ItemView {
  plugin: PenseedPlugin;
  private items: ForeshadowingItem[] = [];
  private projectId: number | null = null;
  private boardEl: HTMLElement | null = null;
  private tooltipEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: PenseedPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_FORESHADOWING_BOARD;
  }

  getDisplayText(): string {
    return "Foreshadowing Board";
  }

  getIcon(): string {
    return "layout-grid";
  }

  async onOpen(): Promise<void> {
    this.projectId = this.plugin.settings.lastProjectId;
    await this.loadBoard();
  }

  async onClose(): Promise<void> {
    this.hideTooltip();
    this.tooltipEl?.remove();
    this.tooltipEl = null;
    this.contentEl.empty();
  }

  refresh(): void {
    void this.loadBoard();
  }

  private async loadBoard(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("penseed-board");

    const token = await this.plugin.auth.getAccessToken();
    if (!token) {
      this.renderAuthRequired();
      return;
    }

    let projects: PenseedProject[];
    try {
      projects = await listProjects(this.plugin.settings.apiUrl, token);
    } catch (e) {
      this.renderError(e);
      return;
    }

    if (projects.length === 0) {
      this.renderNoProjects();
      return;
    }

    if (
      this.projectId === null ||
      !projects.some((p) => p.id === this.projectId)
    ) {
      this.projectId = projects[0].id;
    }

    this.renderHeader(projects);
    this.boardEl = container.createDiv({ cls: "penseed-board-columns" });
    this.boardEl.createDiv({
      cls: "penseed-board-loading",
      text: "Loading foreshadowings…",
    });

    let result: ForeshadowingListByProjectResult;
    try {
      result = await listForeshadowingsByProject(
        this.plugin.settings.apiUrl,
        token,
        this.projectId
      );
    } catch (e) {
      this.renderBoardError(e);
      return;
    }

    this.items = result.items ?? [];
    this.renderColumns();
  }

  private renderHeader(projects: PenseedProject[]): void {
    const header = this.contentEl.createDiv({ cls: "penseed-board-header" });

    const select = header.createEl("select", { cls: "dropdown" });
    for (const p of projects) {
      select.createEl("option", { text: p.title, value: String(p.id) });
    }
    select.value = String(this.projectId);
    select.addEventListener("change", () => {
      this.projectId = Number(select.value);
      this.plugin.settings.lastProjectId = this.projectId;
      void this.plugin.saveSettings();
      void this.loadBoard();
    });

    const refreshBtn = header.createEl("button", {
      cls: "penseed-board-refresh",
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.setAttribute("aria-label", "Refresh board");
    refreshBtn.addEventListener("click", () => {
      void this.loadBoard();
    });
  }

  private renderColumns(): void {
    if (!this.boardEl) return;
    this.boardEl.empty();

    for (const col of COLUMNS) {
      const columnEl = this.boardEl.createDiv({ cls: "penseed-col" });
      columnEl.dataset.status = col.status;

      const headerEl = columnEl.createDiv({ cls: "penseed-col-header" });
      headerEl.createSpan({ cls: "penseed-col-title", text: col.label });
      headerEl.createSpan({ cls: "penseed-col-count", text: "0" });

      columnEl.createDiv({ cls: "penseed-col-body" });

      columnEl.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        columnEl.addClass("penseed-col-dragover");
      });
      columnEl.addEventListener("dragleave", (e) => {
        if (!columnEl.contains(e.relatedTarget as Node)) {
          columnEl.removeClass("penseed-col-dragover");
        }
      });
      columnEl.addEventListener("drop", (e) => {
        e.preventDefault();
        columnEl.removeClass("penseed-col-dragover");
        const idRaw = e.dataTransfer?.getData("text/plain");
        if (idRaw) {
          void this.handleDrop(Number(idRaw), col.status);
        }
      });
    }

    for (const item of this.items) {
      this.appendCard(item);
    }

    this.updateColumnCounts();
  }

  private appendCard(item: ForeshadowingItem): void {
    if (!this.boardEl) return;
    const status = item.status ?? "pending";
    const bodyEl = this.boardEl.querySelector<HTMLElement>(
      `.penseed-col[data-status="${status}"] .penseed-col-body`
    );
    if (!bodyEl) return;

    const card = bodyEl.createDiv({ cls: "penseed-card" });
    card.draggable = true;
    card.dataset.id = String(item.id);

    const topEl = card.createDiv({ cls: "penseed-card-top" });
    const dotCls =
      item.priority !== null && item.priority !== undefined
        ? `penseed-priority-dot penseed-priority-${item.priority}`
        : "penseed-priority-dot";
    topEl.createSpan({ cls: dotCls });
    topEl.createSpan({
      cls: "penseed-card-text",
      text: truncate(item.foreshadowing_text_preview),
    });

    if (item.chapter_title) {
      card.createDiv({ cls: "penseed-card-chapter", text: item.chapter_title });
    }

    card.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("text/plain", String(item.id));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      card.addClass("penseed-card-dragging");
    });
    card.addEventListener("dragend", () => {
      card.removeClass("penseed-card-dragging");
    });
    card.addEventListener("mouseenter", () => {
      this.showTooltip(item, card);
    });
    card.addEventListener("mouseleave", () => {
      this.hideTooltip();
    });
    card.addEventListener("dblclick", () => {
      void this.openAndHighlight(item);
    });
  }

  private showTooltip(item: ForeshadowingItem, card: HTMLElement): void {
    const text = item.foreshadowing_text_preview;
    // Only surface a tooltip when the card actually truncates the text.
    if (!text || text.length <= 80) return;

    if (!this.tooltipEl) {
      this.tooltipEl = document.body.createDiv({ cls: "penseed-card-tooltip" });
    }
    const tooltip = this.tooltipEl;
    tooltip.textContent = text;
    tooltip.removeClass("is-visible");
    if (!tooltip.isConnected) document.body.appendChild(tooltip);

    const rect = card.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();

    // Right-align the tooltip to the card's right edge, expanding leftwards so
    // it never overflows the right edge of the viewport.
    let left = rect.right - tipRect.width;
    left = Math.max(8, left);

    // Keep the tooltip's top from rising above the card (avoids the header),
    // but pull it back up if it would overflow the bottom of the viewport.
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

  /**
   * Phase 0.24: double-click a card to open its chapter note and highlight the
   * exact foreshadowing sentence in the source. Reuses the same
   * "chapter_number → note filename" mapping the reanalysis flow already relies
   * on (main.ts `noteByNumber`), so no backend change is needed.
   */
  private resolveNoteByChapterNumber(chapterNumber: number): TFile | null {
    const projectId = this.projectId;
    if (projectId === null) return null;
    const folderMap = this.plugin.settings.folderProjectMap ?? {};
    const mappedFolders = Object.keys(folderMap).filter(
      (folder) => folderMap[folder] === projectId
    );

    for (const f of this.app.vault.getMarkdownFiles()) {
      const n = extractChapterNumber(f.basename);
      if (n !== chapterNumber) continue;
      const parent = f.parent?.path ?? "";
      // Project isolation: chapter numbers collide across projects (both have a
      // "Chapter 1"). Only accept notes under folders mapped to THIS project.
      if (mappedFolders.length > 0) {
        const belongs = mappedFolders.some(
          (folder) => parent === folder || parent.startsWith(folder + "/")
        );
        if (!belongs) continue;
      }
      return f;
    }
    return null;
  }

  private async openAndHighlight(item: ForeshadowingItem): Promise<void> {
    const chapterNumber = item.chapter?.chapter_number;
    if (typeof chapterNumber !== "number") {
      notify("This foreshadowing has no chapter — open it on the web.");
      return;
    }

    const note = this.resolveNoteByChapterNumber(chapterNumber);
    if (!note) {
      notify("No local note matched this chapter in this project.");
      return;
    }

    // Open in a tab leaf (not this board leaf, which can't host Markdown).
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(note);

    const text = item.foreshadowing_text_preview;
    if (!text || !text.trim()) return;

    let content: string;
    try {
      content = await this.app.vault.read(note);
    } catch {
      return;
    }

    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;

    // Fuzzy-locate the sentence: exact → case-insensitive → normalized →
    // token-anchor, each step mapping back to exact source offsets.
    const match = locateMatch(content, text);
    if (!match) {
      notify("Original text was edited — opened the chapter without highlighting.");
      return;
    }

    const editor = view.editor;
    const from = editor.offsetToPos(match.from);
    const to = editor.offsetToPos(match.to);
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, true);
  }

  private async handleDrop(id: number, newStatus: string): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    const oldStatus = item.status ?? "pending";
    if (oldStatus === newStatus) return;

    // Optimistic reorder: move the card into the target column immediately,
    // then persist. On failure the whole board is reloaded to roll back.
    const targetBody = this.boardEl?.querySelector(
      `.penseed-col[data-status="${newStatus}"] .penseed-col-body`
    ) as HTMLElement | null;
    const cardEl = this.boardEl?.querySelector(
      `.penseed-card[data-id="${id}"]`
    ) as HTMLElement | null;
    if (targetBody && cardEl) {
      targetBody.appendChild(cardEl);
      item.status = newStatus;
      this.updateColumnCounts();
    }

    const token = await this.plugin.auth.getAccessToken();
    if (!token) {
      notify("Please connect to Penseed in Settings first.");
      await this.loadBoard();
      return;
    }

    try {
      await updateForeshadowingStatus(
        this.plugin.settings.apiUrl,
        token,
        id,
        newStatus
      );
    } catch (e) {
      notify(
        e instanceof ApiError
          ? e.userMessage
          : "Failed to update foreshadowing status."
      );
      await this.loadBoard();
    }
  }

  private updateColumnCounts(): void {
    if (!this.boardEl) return;
    for (const col of COLUMNS) {
      const countEl = this.boardEl.querySelector<HTMLElement>(
        `.penseed-col[data-status="${col.status}"] .penseed-col-count`
      );
      if (!countEl) continue;
      const count = this.boardEl.querySelectorAll(
        `.penseed-col[data-status="${col.status}"] .penseed-card`
      ).length;
      countEl.textContent = String(count);
    }
  }

  private renderAuthRequired(): void {
    const box = this.contentEl.createDiv({ cls: "penseed-board-empty" });
    box.createDiv({ cls: "penseed-board-empty-title", text: "Connect to Penseed" });
    box.createDiv({
      cls: "penseed-board-empty-text",
      text: "Sign in to Penseed in Settings to see your foreshadowing board.",
    });
    const btn = box.createEl("button", { text: "Open Settings", cls: "mod-cta" });
    btn.addEventListener("click", () => {
      try {
        const setting = (this.app as unknown as {
          setting?: { open: () => void; openTabById?: (id: string) => void };
        }).setting;
        if (setting?.open) {
          setting.open();
          setting.openTabById?.("penseed");
          return;
        }
      } catch {
        // fall through to Notice
      }
      notify("Open Settings → Penseed to connect.");
    });
  }

  private renderNoProjects(): void {
    const box = this.contentEl.createDiv({ cls: "penseed-board-empty" });
    box.createDiv({ cls: "penseed-board-empty-title", text: "No projects yet" });
    box.createDiv({
      cls: "penseed-board-empty-text",
      text: "Create a project in Penseed first, then open the board here.",
    });
    const btn = box.createEl("button", { text: "Open Penseed", cls: "mod-cta" });
    btn.addEventListener("click", () => {
      window.open("https://penseed.app", "_blank");
    });
  }

  private renderError(e: unknown): void {
    const box = this.contentEl.createDiv({ cls: "penseed-board-empty" });
    box.createDiv({ cls: "penseed-board-empty-title", text: "Something went wrong" });
    box.createDiv({ cls: "penseed-board-empty-text", text: errorMessage(e) });
  }

  private renderBoardError(e: unknown): void {
    if (!this.boardEl) return;
    this.boardEl.empty();
    const box = this.boardEl.createDiv({ cls: "penseed-board-empty" });
    box.createDiv({
      cls: "penseed-board-empty-title",
      text: "Couldn't load the board",
    });
    box.createDiv({ cls: "penseed-board-empty-text", text: errorMessage(e) });
    const btn = box.createEl("button", { text: "Retry", cls: "mod-cta" });
    btn.addEventListener("click", () => {
      void this.loadBoard();
    });
  }
}
