import { Notice, Plugin, SuggestModal, TFile, setIcon } from "obsidian";
import {
  PenseedSettings,
  PenseedSettingTab,
  DEFAULT_SETTINGS,
} from "./settings";
import {
  ApiError,
  listProjects,
  createChapter,
  listChapters,
  listEntities,
  listForeshadowings,
  startSingleReanalysis,
  getSingleReanalysisStatus,
  startReanalysisBatch,
  getReanalysisBatchStatus,
  extractForeshadowing,
  extractEntities,
  saveForeshadowingsBatch,
  saveEntities,
  analyzeChapterResolution,
  updateForeshadowingStatus,
  cancelReanalysisBatch,
  PenseedProject,
  PenseedChapter,
  ForeshadowingSavePayload,
  ReanalysisBatchChapter,
  ReanalyzeResult,
} from "./api";
import {
  ReanalysisResultModal,
  ConfirmReanalysisModal,
  BatchProgressModal,
  ReplayItem,
  ReanalysisBatchTaskState,
  ReanalysisTarget,
  ReanalysisDecision,
  WEB_BASE_URL,
} from "./ui";
import {
  AnalysisReviewModal,
  ReviewResolvedItem,
  ReviewChapterSummary,
  ReviewSelection,
} from "./review";
import { PenseedAuthManager } from "./auth";
import {
  ForeshadowingBoardView,
  VIEW_TYPE_FORESHADOWING_BOARD,
} from "./board";

const CN_DIGITS: Record<string, number> = {
  "零": 0, "〇": 0,
  "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
  "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
};

const CN_UNITS: Record<string, number> = {
  "十": 10, "百": 100, "千": 1000, "万": 10000,
};

function chineseToNumber(text: string): number | null {
  let total = 0;
  let section = 0;
  let number = 0;
  for (const ch of text) {
    if (ch in CN_DIGITS) {
      number = CN_DIGITS[ch];
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      if (unit === 10000) {
        section = (section + number) * unit;
        total += section;
        section = 0;
      } else {
        section += (number === 0 ? 1 : number) * unit;
      }
      number = 0;
    } else {
      return null;
    }
  }
  return total + section + number;
}

function extractChapterNumber(filename: string): number | null {
  // 1. 中文「第N章/回/节/卷/部」优先
  const chinese = filename.match(/第([零〇一二两三四五六七八九十百千万]+)[章回节卷部]/);
  if (chinese) {
    const value = chineseToNumber(chinese[1]);
    if (value !== null) return value;
  }

  // 2. 英文「Chapter N / Ch.N」次优先（避免把标题里的数字误当章节号）
  const english = filename.match(/chapter\s*(\d+)/i);
  if (english) return parseInt(english[1], 10);

  // 3. 阿拉伯数字兜底：先剥掉日期前缀（如 2026-09-28），再取第一个独立数字。
  //    修复：/\d+/ 会误抓日期年份（"2026-09-28 第5章" → 抓到 2026）。
  const stripped = filename.replace(/^\d{4}[-_.\/]\d{1,2}[-_.\/]\d{1,2}[-_.\/]?/, "");
  const arabic = stripped.match(/\d+/);
  if (arabic) return parseInt(arabic[0], 10);

  return null;
}

function smartWordCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const chars = [...trimmed];
  const nonAscii = chars.filter((ch) => ch.charCodeAt(0) > 127).length;
  if (chars.length > 0 && nonAscii / chars.length > 0.3) {
    return trimmed.replace(/\s/g, "").length;
  }
  return trimmed.split(/\s+/).length;
}

function toStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map((v) => String(v)) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retryable = network-level failure (no status) or a transient 5xx from the
 * reverse proxy. Auth/quota/client errors (4xx, 402, 429) must not be retried.
 */
function isRetryableError(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  return e.status === null || e.status >= 500;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 2000
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt < attempts && isRetryableError(e)) {
        await sleep(baseDelayMs * Math.pow(2, attempt - 1));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

class ProjectSuggestModal extends SuggestModal<PenseedProject> {
  private projects: PenseedProject[];
  private resolve: (project: PenseedProject | null) => void;
  private settled = false;

  constructor(
    app: import("obsidian").App,
    projects: PenseedProject[],
    resolve: (project: PenseedProject | null) => void
  ) {
    super(app);
    this.projects = projects;
    this.resolve = resolve;
    this.setPlaceholder("Choose a Penseed project");
  }

  getSuggestions(query: string): PenseedProject[] {
    const q = query.toLowerCase();
    return this.projects.filter((p) => p.title.toLowerCase().includes(q));
  }

  renderSuggestion(project: PenseedProject, el: HTMLElement): void {
    el.createDiv({ text: project.title });
    el.createEl("small", { text: `Project #${project.id}` });
  }

  onChooseSuggestion(
    project: PenseedProject,
    evt: MouseEvent | KeyboardEvent
  ): void {
    this.settled = true;
    this.resolve(project);
  }

  onClose(): void {
    // Obsidian calls close() BEFORE onChooseSuggestion() when a suggestion is
    // selected, so resolving null here would win the race and swallow the
    // choice. Defer cancellation to the next task; a real selection (which
    // fires synchronously right after close) then wins instead.
    window.setTimeout(() => {
      if (!this.settled) {
        this.settled = true;
        this.resolve(null);
      }
    }, 0);
    super.onClose();
  }
}

interface SingleReanalysisTaskState {
  taskId: string;
  projectId: number;
  chapterId: number;
  status: "running" | "completed" | "error" | "cancelled";
  error: string | null;
  result: ReanalyzeResult | null;
}

export default class PenseedPlugin extends Plugin {
  settings!: PenseedSettings;
  auth!: PenseedAuthManager;
  private batchTask: ReanalysisBatchTaskState | null = null;
  private singleTask: SingleReanalysisTaskState | null = null;
  private batchStatusItem: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.auth = new PenseedAuthManager(this.app, this.settings.apiUrl);

    this.addSettingTab(new PenseedSettingTab(this.app, this));

    this.addRibbonIcon("feather", "Analyze current note with Penseed", () => {
      void this.analyzeCurrentNote();
    });

    this.registerView(
      VIEW_TYPE_FORESHADOWING_BOARD,
      (leaf) => new ForeshadowingBoardView(leaf, this)
    );

    this.addRibbonIcon("layout-grid", "Open foreshadowing board", () => {
      void this.activateBoardView();
    });

    this.addCommand({
      id: "analyze-current-note",
      name: "Analyze Current Note",
      callback: () => this.analyzeCurrentNote(),
    });

    this.addCommand({
      id: "open-foreshadowing-board",
      name: "Open Foreshadowing Board",
      callback: () => this.activateBoardView(),
    });

    this.addCommand({
      id: "reassign-folder-project",
      name: "Change project for this note's folder",
      callback: () => this.reassignFolderProject(),
    });

    // Persistent reminder: project-wide reports (element conflicts / World State /
    // rules) are no longer auto-run after re-analysis — the author triggers them on
    // the web. Kept in the status bar so it's always visible without opening a panel.
    const statusItem = this.addStatusBarItem();
    statusItem.addClass("penseed-status-warning");
    const statusIcon = statusItem.createSpan({ cls: "penseed-status-warning-icon" });
    setIcon(statusIcon, "alert-triangle");
    statusItem.createSpan({
      text: "Penseed: run conflicts / World State / rules on web",
    });
    statusItem.setAttribute(
      "title",
      "Project-wide reports (element conflicts, World State, rules) are not updated automatically. Open the Penseed web app to run them."
    );
    statusItem.addEventListener("click", () => {
      const projectId = this.settings.lastProjectId;
      window.open(
        projectId ? `${WEB_BASE_URL}/projects/${projectId}` : WEB_BASE_URL,
        "_blank"
      );
    });

    // Batch re-analysis progress indicator: hidden until a task starts, then
    // shows "重分析 N/M" and re-opens the live progress modal on click.
    this.batchStatusItem = this.addStatusBarItem();
    this.batchStatusItem.addClass("penseed-batch-status");
    this.batchStatusItem.hide();
    this.batchStatusItem.addEventListener("click", () => {
      if (this.batchTask) {
        this.openBatchProgressModal();
      } else if (this.singleTask?.status === "running") {
        new Notice("Single-chapter re-analysis is running in the background.");
      }
    });
  }

  async onunload(): Promise<void> {
    // Stop the background poll loop from touching a disposed plugin.
    this.batchTask = null;
    this.singleTask = null;
    this.batchStatusItem = null;
  }

  async activateBoardView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_FORESHADOWING_BOARD)[0];
    if (existing) {
      void workspace.revealLeaf(existing);
      const view = existing.view;
      if (view instanceof ForeshadowingBoardView) view.refresh();
      return;
    }
    const leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
    await leaf.setViewState({
      type: VIEW_TYPE_FORESHADOWING_BOARD,
      active: true,
    });
    void workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    ) as PenseedSettings;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async analyzeCurrentNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("Please open a Markdown note first.");
      return;
    }

    const token = await this.auth.getAccessToken();
    if (!token) {
      new Notice("Please connect to Penseed in Settings first.");
      return;
    }

    const apiUrl = this.settings.apiUrl;

    let content: string;
    try {
      content = await this.app.vault.read(file);
    } catch (e) {
      new Notice("Penseed analysis failed.");
      console.error("[Penseed] Failed to read note", e);
      return;
    }

    // Resolve the target project. A remembered folder→project mapping wins when
    // still valid; otherwise prompt and remember the choice so the same folder
    // routes to the same project on subsequent analyses.
    const folderPath = file.parent?.path ?? "";
    let projectId: number;
    let projects: PenseedProject[] = [];
    try {
      projects = await listProjects(apiUrl, token);
      if (projects.length === 0) {
        new Notice("You don't have any projects yet. Create one at Penseed first.");
        return;
      }
      const mapped = this.settings.folderProjectMap[folderPath];
      if (mapped !== undefined && projects.some((p) => p.id === mapped)) {
        projectId = mapped;
      } else {
        const chosen = await this.chooseProject(projects);
        if (chosen === null) return;
        projectId = chosen.id;
        this.settings.folderProjectMap[folderPath] = projectId;
        this.settings.lastProjectId = projectId;
        await this.saveSettings();
      }
    } catch (e) {
      this.notifyError(e);
      return;
    }

    const notice = new Notice("Analyzing with Penseed...", 0);

    try {
      const parsedChapterNumber = extractChapterNumber(file.basename);
      const wordCount = smartWordCount(content);

      // get_or_create the chapter by chapter_number. `isNew` (201 vs 200) is the
      // branch point: a brand-new chapter goes through extract → review → save,
      // while an existing chapter re-runs in place. When a note collides with an
      // existing chapter in the remembered project, confirm before overwriting.
      let chapter: PenseedChapter;
      let isNew = false;
      for (;;) {
        const created = await createChapter(
          apiUrl,
          token,
          projectId,
          file.basename,
          parsedChapterNumber,
          wordCount,
          content
        );
        chapter = created.chapter;
        isNew = created.isNew;

        if (isNew) break;

        const targetProject = projects.find((p) => p.id === projectId);
        const decision = await this.confirmReanalysis({
          projectTitle: targetProject?.title ?? `#${projectId}`,
          chapterNumber: chapter.chapter_number ?? parsedChapterNumber,
          chapterTitle: chapter.title ?? file.basename,
        });

        if (decision === "overwrite") break;
        if (decision === "cancel") {
          notice.hide();
          return;
        }

        // "Choose Different Project": re-pick and retry get_or_create there.
        const chosen = await this.chooseProject(projects);
        if (chosen === null) {
          notice.hide();
          return;
        }
        projectId = chosen.id;
        this.settings.folderProjectMap[folderPath] = projectId;
        this.settings.lastProjectId = projectId;
        await this.saveSettings();
      }

      if (!isNew) {
        // Historical chapter: recompute in place as a background task, then poll
        // and render the result (Phase 0.20). The synchronous reanalyze request
        // was dropped because it took tens of seconds and could time out at the
        // plugin network layer even though the server finished the work.
        notice.hide();
        await this.submitSingleReanalysis(
          apiUrl,
          token,
          chapter,
          content,
          projectId
        );
        return;
      }

      // New chapter: extract candidates and entities without committing, run
      // resolution analysis, then let the author pick what to keep.
      const chapterNumber = chapter.chapter_number ?? parsedChapterNumber;

      const [foreshadowingResult, entityResult, resolutionResult] =
        await Promise.allSettled([
          extractForeshadowing(apiUrl, token, projectId, chapter.id, content),
          extractEntities(apiUrl, token, projectId, content),
          analyzeChapterResolution(apiUrl, token, projectId, chapter.id, content),
        ]);
      notice.hide();

      const candidates =
        foreshadowingResult.status === "fulfilled"
          ? foreshadowingResult.value.candidates ?? []
          : [];
      const entities =
        entityResult.status === "fulfilled"
          ? (entityResult.value.entities ?? []).map((e) => ({
              name: e.name,
              type: e.type,
              aliases: e.aliases,
              attributes: e.attributes,
              description: e.description,
            }))
          : [];
      const resolution =
        resolutionResult.status === "fulfilled" && resolutionResult.value.success
          ? resolutionResult.value.data
          : undefined;

      const resolvedItems: ReviewResolvedItem[] = [];
      for (const raw of resolution?.resolved_foreshadowings ?? []) {
        const item = raw as {
          is_resolved?: boolean;
          confidence?: number;
          resolution_type?: string;
          evidence?: string;
          foreshadowing?: {
            id?: number;
            foreshadowing_text_preview?: string;
            title?: string;
          };
        };
        if (item.is_resolved !== true) continue;
        if (typeof item.foreshadowing?.id !== "number") continue;
        resolvedItems.push({
          id: item.foreshadowing.id,
          text:
            item.foreshadowing.foreshadowing_text_preview ??
            item.foreshadowing.title ??
            "",
          confidence: typeof item.confidence === "number" ? item.confidence : null,
          resolutionType: item.resolution_type ?? null,
          evidence: item.evidence ?? null,
        });
      }

      const chapterSummary = resolution?.chapter_summary;
      const summary: ReviewChapterSummary | null = chapterSummary
        ? {
            revelations: toStringArray(chapterSummary.revelations),
            resolutions: toStringArray(chapterSummary.resolutions),
            plot_advances: toStringArray(chapterSummary.plot_advances),
            key_entities: toStringArray(chapterSummary.key_entities),
          }
        : null;

      new AnalysisReviewModal(this.app, {
        projectId,
        chapterId: chapter.id,
        chapterNumber,
        candidates,
        entities,
        resolvedItems,
        summary,
        onSave: (selection) =>
          this.saveReviewSelections(
            apiUrl,
            token,
            projectId,
            chapter.id,
            chapterNumber,
            selection
          ),
      }).open();
    } catch (e) {
      notice.hide();
      this.notifyError(e);
    }
  }

  private async saveReviewSelections(
    apiUrl: string,
    token: string,
    projectId: number,
    chapterId: number,
    chapterNumber: number | null,
    selection: ReviewSelection
  ): Promise<void> {
    const items: ForeshadowingSavePayload[] = [];

    for (const candidate of selection.candidates) {
      const text = candidate.foreshadowing_text_preview ?? candidate.text ?? "";
      if (!text.trim()) continue;
      items.push({
        project_id: projectId,
        chapter_id: chapterId,
        foreshadowing_text_preview: text.slice(0, 2000),
        confidence:
          typeof candidate.confidence === "number"
            ? candidate.confidence
            : 0.5,
        start_position:
          typeof candidate.start_position === "number"
            ? candidate.start_position
            : -1,
        end_position:
          typeof candidate.end_position === "number"
            ? candidate.end_position
            : -1,
        is_foreshadowing: candidate.is_foreshadowing ?? true,
        foreshadowing_type: candidate.foreshadowing_type ?? undefined,
        target_elements: candidate.target_elements ?? undefined,
        emotional_tone: candidate.emotional_tone ?? undefined,
        narrative_function: candidate.narrative_function ?? undefined,
        analysis: candidate.analysis ?? undefined,
        improvement_suggestions:
          candidate.improvement_suggestions ?? undefined,
      });
    }

    let saved = 0;
    let skipped = 0;
    const failedErrors: string[] = [];

    if (items.length > 0) {
      try {
        const result = await saveForeshadowingsBatch(apiUrl, token, items);
        saved = result.created_count ?? 0;
        skipped = result.skipped_count ?? 0;
        for (const err of result.errors ?? []) {
          if (err) failedErrors.push(err);
        }
      } catch (e) {
        failedErrors.push(
          e instanceof ApiError ? e.userMessage : "unknown error"
        );
        console.error("[Penseed] Failed to save foreshadowings", e);
      }
    }

    if (selection.entities.length > 0) {
      try {
        await saveEntities(apiUrl, token, {
          project_id: projectId,
          chapter_id: chapterId,
          chapter_number: chapterNumber,
          entities: selection.entities.map((e) => ({
            name: e.name,
            type: e.type,
            aliases: e.aliases,
            attributes: e.attributes,
            description: e.description,
          })),
        });
      } catch (e) {
        console.error("[Penseed] Failed to save entities", e);
        new Notice("Failed to save elements.");
      }
    }

    let resolvedFailed = 0;
    for (const id of selection.resolvedIds) {
      try {
        await updateForeshadowingStatus(apiUrl, token, id, "resolved");
      } catch (e) {
        resolvedFailed++;
        console.error("[Penseed] Failed to mark foreshadowing resolved", e);
      }
    }

    const failed = failedErrors.length;
    if (failed > 0 || resolvedFailed > 0) {
      const parts: string[] = [];
      if (saved > 0) parts.push(`${saved} saved`);
      if (skipped > 0) parts.push(`${skipped} skipped`);
      if (failed > 0) parts.push(`${failed} failed`);
      if (resolvedFailed > 0) {
        parts.push(`${resolvedFailed} resolve-update failed`);
      }
      const suffix = failedErrors[0] ? ` — ${failedErrors[0]}` : "";
      new Notice(`Penseed: ${parts.join(", ")}.${suffix}`);
    } else {
      new Notice(saved > 0 ? `Saved ${saved} foreshadowing.` : "Saved.");
    }
  }

  private async buildReplayItems(
    apiUrl: string,
    token: string,
    projectId: number,
    affectedChapterIds: number[]
  ): Promise<{
    items: ReplayItem[];
    count: number;
    listChaptersFailed: boolean;
  }> {
    const count = affectedChapterIds.length;
    if (count === 0) {
      return { items: [], count: 0, listChaptersFailed: false };
    }

    // Map chapter id → chapter_number. If this list request fails, we can't map
    // ids to human-readable chapter numbers, so we degrade to a count-only
    // summary instead of showing misleading raw ids (Phase 0.20-06).
    const numberById = new Map<number, number>();
    let listChaptersFailed = false;
    try {
      const chapters = await listChapters(apiUrl, token, projectId);
      for (const c of chapters) {
        if (typeof c.chapter_number === "number") {
          numberById.set(c.id, c.chapter_number);
        }
      }
    } catch (e) {
      listChaptersFailed = true;
      console.error("[Penseed] Failed to list chapters for replay mapping", e);
    }

    if (listChaptersFailed) {
      return { items: [], count, listChaptersFailed: true };
    }

    // Map chapter_number → note file (by leading number in filename).
    const noteByNumber = new Map<number, TFile>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const n = extractChapterNumber(f.basename);
      if (n !== null) noteByNumber.set(n, f);
    }

    const items = affectedChapterIds.map((id) => {
      const chapterNumber = numberById.get(id);
      const note =
        chapterNumber !== undefined ? noteByNumber.get(chapterNumber) : undefined;
      return {
        chapterNumber: chapterNumber ?? id,
        noteTitle: note ? note.basename : null,
      };
    });

    return { items, count, listChaptersFailed: false };
  }

  private async submitSingleReanalysis(
    apiUrl: string,
    token: string,
    chapter: PenseedChapter,
    content: string,
    projectId: number
  ): Promise<void> {
    if (
      this.singleTask?.status === "running" ||
      this.batchTask?.status === "running"
    ) {
      new Notice("A re-analysis is already running. Wait for it to finish.");
      return;
    }

    const started = await startSingleReanalysis(apiUrl, token, chapter.id, content);

    this.singleTask = {
      taskId: started.task_id,
      projectId,
      chapterId: chapter.id,
      status: "running",
      error: null,
      result: null,
    };

    this.renderStatus();
    new Notice(
      "Re-analysis submitted. It runs in the background — check the status bar for progress."
    );
    void this.pollSingleTaskInBackground();
  }

  private async pollSingleTaskInBackground(): Promise<void> {
    const task = this.singleTask;
    if (!task) return;

    const apiUrl = this.settings.apiUrl;
    const token = await this.auth.getAccessToken();
    if (!token) {
      task.status = "error";
      task.error = "Penseed authentication lost. Reconnect in Settings.";
      this.renderStatus();
      return;
    }

    while (this.singleTask === task && task.status === "running") {
      try {
        const status = await withRetry(() =>
          getSingleReanalysisStatus(apiUrl, token, task.taskId)
        );

        if (status.status === "completed") {
          task.status = "completed";
          task.result = status.result ?? null;
          break;
        }
        if (status.status === "error") {
          task.status = "error";
          task.error = status.error || "Re-analysis failed.";
          break;
        }
        if (status.status === "cancelled") {
          task.status = "cancelled";
          break;
        }
      } catch (e) {
        task.status = "error";
        task.error =
          e instanceof ApiError ? e.userMessage : "Re-analysis failed.";
        console.error("[Penseed] Single re-analysis poll failed", e);
        break;
      }

      this.renderStatus();
      await sleep(3000);
    }

    // Plugin unloaded mid-poll: the task was detached; do not touch the UI.
    if (this.singleTask !== task) return;

    this.renderStatus();
    if (task.status === "completed") {
      await this.renderSingleReanalysisResult(task);
    } else if (task.status === "error") {
      new Notice(task.error || "单章重分析失败。");
    } else if (task.status === "cancelled") {
      new Notice("单章重分析已取消。");
    }
  }

  private async renderSingleReanalysisResult(
    task: SingleReanalysisTaskState
  ): Promise<void> {
    const result = task.result;
    if (!result) {
      new Notice("Re-analysis completed but returned no result.");
      return;
    }

    const apiUrl = this.settings.apiUrl;
    const token = await this.auth.getAccessToken();
    if (!token) return;

    const built = await this.buildReplayItems(
      apiUrl,
      token,
      task.projectId,
      result.affected_downstream_chapters
    );

    // Fetch the chapter's current foreshadowings & entities so the result modal
    // can list exactly what was extracted. Editing/removal stays on the web app
    // (read-only here). If a list request fails, surface a hint in the modal
    // instead of silently dropping the section (Phase 0.20-07).
    const [fsResult, entityResult] = await Promise.allSettled([
      listForeshadowings(apiUrl, token, task.chapterId, task.projectId),
      listEntities(apiUrl, token, task.projectId, task.chapterId),
    ]);

    const foreshadowings =
      fsResult.status === "fulfilled"
        ? (fsResult.value.items ?? []).map((f) => ({
            text: f.foreshadowing_text_preview ?? "",
            status: typeof f.status === "string" ? f.status : "",
          }))
        : [];
    const entities =
      entityResult.status === "fulfilled"
        ? entityResult.value.map((e) => ({
            name: e.display_name ?? e.canonical_name,
            type: e.entity_type,
          }))
        : [];

    new ReanalysisResultModal(this.app, {
      entityCount: result.entity_count,
      foreshadowingCount: result.foreshadowing_count,
      addedForeshadowings: result.added_foreshadowings,
      deletedForeshadowings: result.deleted_foreshadowings,
      semanticChangedCount: result.semantic_changed_count,
      resolvedCount: result.foreshadowings_resolved,
      partiallyResolved: result.partially_resolved,
      progressed: result.progressed,
      estimatedReplayCredits: result.estimated_replay_credits,
      projectId: task.projectId,
      affected: built.items,
      affectedCount: built.count,
      affectedListUnavailable: built.listChaptersFailed,
      isFirstAnalysis: false,
      unchanged: result.noop === true,
      foreshadowings,
      entities,
      foreshadowingsError: fsResult.status !== "fulfilled",
      entitiesError: entityResult.status !== "fulfilled",
      onBatchReplay: () =>
        this.batchReanalyze(
          apiUrl,
          token,
          task.projectId,
          result.affected_downstream_chapters
        ),
    }).open();
  }

  private async batchReanalyze(
    apiUrl: string,
    token: string,
    projectId: number,
    chapterIds: number[]
  ): Promise<void> {
    // 重复触发防护：已有进行中的批处理任务时，不重复提交，直接打开进度浮窗。
    if (this.singleTask?.status === "running") {
      new Notice("A single-chapter re-analysis is already running.");
      return;
    }
    if (this.batchTask?.status === "running") {
      new Notice("A batch re-analysis is already running.");
      this.openBatchProgressModal();
      return;
    }

    // Map chapter id → chapter_number + stale, and chapter_number → note file.
    const numberById = new Map<number, number>();
    const staleById = new Map<number, boolean>();
    try {
      const chapters = await listChapters(apiUrl, token, projectId);
      for (const c of chapters) {
        if (typeof c.chapter_number === "number") {
          numberById.set(c.id, c.chapter_number);
        }
        staleById.set(c.id, c.stale === true);
      }
    } catch (e) {
      console.error("[Penseed] Failed to list chapters for batch reanalysis", e);
    }

    const noteByNumber = new Map<number, TFile>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const n = extractChapterNumber(f.basename);
      if (n !== null) noteByNumber.set(n, f);
    }

    // 断点续跑：只提交仍 stale 的章。已处理章 stale=False，重提交被过滤掉，避免
    // 后端总量 quota 预检把已完成章的 credits 再算一遍（stale 信息缺失时保守全量提交）。
    const staleIds = chapterIds.filter((id) => staleById.get(id) !== false);

    // Order by chapter number ascending, then read each chapter's text once and
    // submit the whole set in a single POST. The backend runs the wave server-side
    // (start_wave → per-chapter deferred reanalysis → end_wave) so the plugin can
    // go offline right after — we only poll for progress.
    const ordered = staleIds
      .map((id) => ({ id, chapterNumber: numberById.get(id) ?? null }))
      .sort((a, b) => (a.chapterNumber ?? 0) - (b.chapterNumber ?? 0));

    const payload: ReanalysisBatchChapter[] = [];
    let skippedNoNote = 0;
    for (const { id, chapterNumber } of ordered) {
      const note =
        chapterNumber !== null ? noteByNumber.get(chapterNumber) : undefined;
      if (!note) {
        skippedNoNote++;
        continue;
      }
      try {
        const content = await this.app.vault.read(note);
        payload.push({ chapter_id: id, content });
      } catch (e) {
        console.error("[Penseed] Failed to read note for chapter", id, e);
        skippedNoNote++;
      }
    }

    if (payload.length === 0) {
      new Notice(
        "No chapters to re-analyze (all up to date, or local notes not found)."
      );
      return;
    }

    const started = await startReanalysisBatch(apiUrl, token, projectId, payload);

    this.batchTask = {
      taskId: started.task_id,
      projectId,
      total: started.total ?? payload.length,
      completed: 0,
      failed: 0,
      currentChapterId: null,
      status: "running",
      error: null,
      converged: null,
      newStaleChapterIds: [],
      skippedNoNote,
      numberById,
    };

    this.renderStatus();
    new Notice(
      "Batch re-analysis submitted. It runs in the background — check the status bar for progress."
    );
    void this.pollBatchTaskInBackground();
  }

  private async pollBatchTaskInBackground(): Promise<void> {
    const task = this.batchTask;
    if (!task) return;

    const apiUrl = this.settings.apiUrl;
    const token = await this.auth.getAccessToken();
    if (!token) {
      task.status = "error";
      task.error = "Penseed authentication lost. Reconnect in Settings.";
      this.renderStatus();
      this.notifyBatchFinished(task);
      return;
    }

    while (this.batchTask === task && task.status === "running") {
      try {
        const status = await withRetry(() =>
          getReanalysisBatchStatus(apiUrl, token, task.taskId)
        );

        task.total = status.total ?? task.total;
        task.completed = status.completed ?? 0;
        task.failed = status.failed ?? 0;
        task.currentChapterId = status.current_chapter ?? null;

        if (status.status === "completed") {
          const result = status.result ?? {
            converged: true,
            new_stale_chapter_ids: [],
            wave_seq: null,
            max_waves_reached: false,
          };
          task.status = "completed";
          task.converged = result.converged ?? true;
          task.newStaleChapterIds = result.new_stale_chapter_ids ?? [];
          break;
        }
        if (status.status === "error") {
          task.status = "error";
          task.error = status.error || "Batch re-analysis failed.";
          break;
        }
        if (status.status === "cancelled") {
          task.status = "cancelled";
          break;
        }
      } catch (e) {
        // Non-retryable (4xx/402/429) or retries exhausted. Surface and stop.
        task.status = "error";
        task.error =
          e instanceof ApiError ? e.userMessage : "Batch re-analysis failed.";
        console.error("[Penseed] Batch re-analysis poll failed", e);
        break;
      }

      this.renderStatus();
      await sleep(3000);
    }

    // Plugin unloaded mid-poll: the task was detached; do not touch the UI.
    if (this.batchTask !== task) return;

    this.renderStatus();
    this.notifyBatchFinished(task);
  }

  private renderStatus(): void {
    if (!this.batchStatusItem) return;
    const single = this.singleTask;
    const batch = this.batchTask;
    if (single?.status === "running") {
      this.renderSingleStatus();
      return;
    }
    if (batch) {
      this.renderBatchStatus();
      return;
    }
    if (single) {
      this.renderSingleStatus();
      return;
    }
    this.batchStatusItem.hide();
  }

  private renderSingleStatus(): void {
    if (!this.batchStatusItem) return;
    const task = this.singleTask;
    if (!task) {
      this.batchStatusItem.hide();
      return;
    }

    this.batchStatusItem.empty();
    this.batchStatusItem.show();

    const icon = this.batchStatusItem.createSpan({
      cls: "penseed-batch-status-icon",
    });

    if (task.status === "running") {
      setIcon(icon, "loader");
      this.batchStatusItem.createSpan({ text: "重分析中…" });
      this.batchStatusItem.setAttribute(
        "title",
        "Single-chapter re-analysis in progress"
      );
    } else if (task.status === "completed") {
      setIcon(icon, "check-circle");
      this.batchStatusItem.createSpan({ text: "重分析完成" });
      this.batchStatusItem.setAttribute(
        "title",
        "Single-chapter re-analysis complete"
      );
    } else if (task.status === "error") {
      setIcon(icon, "alert-circle");
      this.batchStatusItem.createSpan({ text: "重分析失败" });
      this.batchStatusItem.setAttribute(
        "title",
        task.error || "Single-chapter re-analysis failed"
      );
    } else {
      setIcon(icon, "ban");
      this.batchStatusItem.createSpan({ text: "重分析已取消" });
    }
  }

  private renderBatchStatus(): void {
    if (!this.batchStatusItem) return;
    const task = this.batchTask;
    if (!task) {
      this.batchStatusItem.hide();
      return;
    }

    this.batchStatusItem.empty();
    this.batchStatusItem.show();

    const icon = this.batchStatusItem.createSpan({
      cls: "penseed-batch-status-icon",
    });

    if (task.status === "running") {
      setIcon(icon, "loader");
      const total = task.total || 0;
      const completed = task.completed || 0;
      this.batchStatusItem.createSpan({
        text: `重分析 ${completed}/${total}`,
      });
      this.batchStatusItem.setAttribute(
        "title",
        "Batch re-analysis in progress — click for details"
      );
    } else if (task.status === "completed") {
      setIcon(icon, "check-circle");
      this.batchStatusItem.createSpan({
        text: `重分析完成 ${task.completed} 章`,
      });
      this.batchStatusItem.setAttribute(
        "title",
        "Batch re-analysis complete — click for results"
      );
    } else if (task.status === "error") {
      setIcon(icon, "alert-circle");
      this.batchStatusItem.createSpan({ text: "重分析失败" });
      this.batchStatusItem.setAttribute(
        "title",
        task.error || "Batch re-analysis failed"
      );
    } else {
      setIcon(icon, "ban");
      this.batchStatusItem.createSpan({ text: "重分析已取消" });
    }
  }

  private notifyBatchFinished(task: ReanalysisBatchTaskState): void {
    if (task.status === "completed") {
      const parts: string[] = [`重分析完成 ${task.completed} 章`];
      if (task.skippedNoNote > 0) {
        parts.push(`${task.skippedNoNote} 跳过（无本地笔记）`);
      }
      if (task.failed > 0) {
        parts.push(`${task.failed} 失败`);
      }
      new Notice(parts.join("，") + "。");
    } else if (task.status === "error") {
      new Notice(task.error || "批量重分析失败。");
    } else if (task.status === "cancelled") {
      new Notice("批量重分析已取消。");
    }
  }

  private openBatchProgressModal(): void {
    if (!this.batchTask) {
      new Notice("No batch re-analysis task in progress.");
      return;
    }
    new BatchProgressModal(
      this.app,
      () => this.batchTask,
      async () => {
        const task = this.batchTask;
        if (!task || task.status !== "running") return;
        const token = await this.auth.getAccessToken();
        if (!token) return;
        try {
          await cancelReanalysisBatch(this.settings.apiUrl, token, task.taskId);
        } catch (e) {
          this.notifyError(e);
        }
      }
    ).open();
  }

  private async reassignFolderProject(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("Open a note first.");
      return;
    }
    const token = await this.auth.getAccessToken();
    if (!token) {
      new Notice("Please connect to Penseed in Settings first.");
      return;
    }
    let projects: PenseedProject[];
    try {
      projects = await listProjects(this.settings.apiUrl, token);
    } catch (e) {
      this.notifyError(e);
      return;
    }
    if (projects.length === 0) {
      new Notice("You don't have any projects yet. Create one at Penseed first.");
      return;
    }
    const folderPath = file.parent?.path ?? "";
    const chosen = await this.chooseProject(projects);
    if (chosen === null) return;
    this.settings.folderProjectMap[folderPath] = chosen.id;
    this.settings.lastProjectId = chosen.id;
    await this.saveSettings();
    new Notice(`"${folderPath || "Vault root"}" now maps to "${chosen.title}".`);
  }

  private chooseProject(
    projects: PenseedProject[]
  ): Promise<PenseedProject | null> {
    return new Promise((resolve) => {
      new ProjectSuggestModal(this.app, projects, resolve).open();
    });
  }

  private confirmReanalysis(
    target: ReanalysisTarget
  ): Promise<ReanalysisDecision> {
    return new Promise((resolve) => {
      new ConfirmReanalysisModal(this.app, target, resolve).open();
    });
  }

  private notifyError(e: unknown): void {
    if (e instanceof ApiError) {
      new Notice(e.userMessage);
    } else {
      new Notice("Penseed analysis failed.");
    }
    console.error("[Penseed]", e);
  }
}
