import { ItemView, WorkspaceLeaf, Notice, setIcon } from "obsidian";
import type PenseedPlugin from "./main";
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
    select.addEventListener("change", async () => {
      this.projectId = Number(select.value);
      this.plugin.settings.lastProjectId = this.projectId;
      await this.plugin.saveSettings();
      await this.loadBoard();
    });

    const refreshBtn = header.createEl("button", {
      cls: "penseed-board-refresh",
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.setAttribute("aria-label", "Refresh board");
    refreshBtn.addEventListener("click", () => this.loadBoard());
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
    const bodyEl = this.boardEl.querySelector(
      `.penseed-col[data-status="${status}"] .penseed-col-body`
    ) as HTMLElement | null;
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
      new Notice("Please connect to Penseed in Settings first.");
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
      new Notice(
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
      const countEl = this.boardEl.querySelector(
        `.penseed-col[data-status="${col.status}"] .penseed-col-count`
      ) as HTMLElement | null;
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
      new Notice("Open Settings → Penseed to connect.");
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
    btn.addEventListener("click", () => this.loadBoard());
  }
}
