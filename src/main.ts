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
  uploadBatchSyncChunk,
  previewBatchSyncJob,
  startBatchSyncJob,
  cancelBatchSyncJob,
  getBatchAnalysisStatus,
  BatchSyncChapterInput,
  BatchSyncPreview,
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
  OutdatedChaptersModal,
  ClassificationModal,
  SyncPreviewModal,
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
import { notify } from "./notify";
import { extractChapterNumber } from "./chapter";
import { assignPluginChapterNumbers } from "./chapterNumbering";
import {
  classifyManuscriptFiles,
  detectLowDensityFolders,
  ClassifiedFile,
} from "./chapterClassifier";
import { staleChapterIds, staleBadgeText, mapStaleToDisplay } from "./stale";

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
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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

/**
 * Phase 0.23 — free character-level diff: line-based LCS backtrack, returning
 * the total character count of added + removed lines as an approximation of
 * "how much the author actually changed". Used only when leaving a note, to
 * gate the re-analysis reminder — a few typo/punctuation edits stay under the
 * threshold and won't light up the reminder. No LLM, no quota.
 */
function diffChangedChars(oldText: string, newText: string): number {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let changed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      changed += a[i].length; // deleted line
      i++;
    } else {
      changed += b[j].length; // added line
      j++;
    }
  }
  while (i < n) {
    changed += a[i].length;
    i++;
  }
  while (j < m) {
    changed += b[j].length;
    j++;
  }
  return changed;
}

class ProjectSuggestModal extends SuggestModal<PenseedProject> {
  private projects: PenseedProject[];
  private resolve: (project: PenseedProject | null) => void;
  private preferredId: number | null;
  private settled = false;

  constructor(
    app: import("obsidian").App,
    projects: PenseedProject[],
    resolve: (project: PenseedProject | null) => void,
    preferredId?: number | null
  ) {
    super(app);
    this.projects = projects;
    this.resolve = resolve;
    this.preferredId = preferredId ?? null;
    this.setPlaceholder("Choose a Penseed project");
  }

  getSuggestions(query: string): PenseedProject[] {
    const q = query.toLowerCase();
    const matches = this.projects.filter((p) =>
      p.title.toLowerCase().includes(q)
    );
    // 无输入时把上次用过的项目排最前，回车即选；仍可输入/方向键换选。
    if (q === "" && this.preferredId != null) {
      const preferred = matches.find((p) => p.id === this.preferredId);
      if (preferred) {
        return [preferred, ...matches.filter((p) => p.id !== this.preferredId)];
      }
    }
    return matches;
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
  notePath: string;
  content: string;
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
  // Outdated-chapters badge: hidden until the remembered project has stale chapters.
  private staleStatusItem: HTMLElement | null = null;
  private staleChapterIds: number[] = [];
  // Phase 0.23: edit-reminder state — the note path currently flagged, plus the
  // last active note path so "leaving a note" can be detected on leaf changes.
  private changeReminderStatusItem: HTMLElement | null = null;
  private lastActiveNotePath: string | null = null;
  private remindedNotePath: string | null = null;

  // Phase 0.22: last-analyzed content per note path, so the backend's
  // sentence-level semantic gate can compare the author's old vs new text.
  // Bounded to avoid unbounded growth on 2000+ chapter vaults.
  private static readonly MAX_CONTENT_CACHE = 2000;
  private contentCache: Map<string, string> = new Map();

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.loadContentCache();
    this.auth = new PenseedAuthManager(this.app, this.settings.apiUrl);

    this.addSettingTab(new PenseedSettingTab(this.app, this));

    this.addRibbonIcon("feather", "Analyze current note with Penseed", () => {
      void this.analyzeCurrentNote();
    });

    this.registerView(
      VIEW_TYPE_FORESHADOWING_BOARD,
      (leaf) => new ForeshadowingBoardView(leaf, this)
    );

    this.addRibbonIcon("layout-grid", "Open foreshadowing board with Penseed", () => {
      void this.activateBoardView();
    });

    this.addRibbonIcon("book-open", "Sync whole manuscript with Penseed", () => {
      void this.syncManuscript();
    });

    this.addCommand({
      id: "analyze-current-note",
      name: "Analyze Current Note",
      callback: () => this.analyzeCurrentNote(),
    });

    this.addCommand({
      id: "open-foreshadowing-board",
      name: "Open Foreshadowing Board with Penseed",
      callback: () => this.activateBoardView(),
    });

    this.addCommand({
      id: "reassign-folder-project",
      name: "Change project for this note's folder",
      callback: () => this.reassignFolderProject(),
    });

    this.addCommand({
      id: "penseed-sync-manuscript",
      name: "Sync whole manuscript with Penseed",
      callback: () => this.syncManuscript(),
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
    // shows "Re-analyzing N/M" and re-opens the live progress modal on click.
    this.batchStatusItem = this.addStatusBarItem();
    this.batchStatusItem.addClass("penseed-batch-status");
    this.batchStatusItem.hide();
    this.batchStatusItem.addEventListener("click", () => {
      if (this.batchTask) {
        this.openBatchProgressModal();
      } else if (this.singleTask?.status === "running") {
        notify("Single-chapter re-analysis is running in the background.");
      }
    });

    // Outdated-chapters badge: hidden until the remembered project has stale chapters.
    this.staleStatusItem = this.addStatusBarItem();
    this.staleStatusItem.addClass("penseed-stale-badge");
    this.staleStatusItem.hide();
    this.staleStatusItem.addEventListener("click", () => {
      if (this.staleChapterIds.length > 0) {
        void this.openOutdatedChaptersModal();
      }
    });

    // ---- Phase 0.23: edit-reminder ----
    // A persistent status-bar marker that lights up when an analyzed note was
    // edited beyond the threshold and then left. Click re-analyzes; right-click
    // dismisses. Never auto-runs (that would silently spend quota).
    this.changeReminderStatusItem = this.addStatusBarItem();
    this.changeReminderStatusItem.addClass("penseed-change-reminder");
    this.changeReminderStatusItem.hide();
    this.changeReminderStatusItem.addEventListener("click", () => {
      const path = this.remindedNotePath;
      if (path) void this.openNoteAndAnalyze(path);
    });
    this.changeReminderStatusItem.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.clearChangeReminder();
    });

    // Detect "leaving a note" as the natural breakpoint to check for edits.
    this.lastActiveNotePath = this.app.workspace.getActiveFile()?.path ?? null;
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const prev = this.lastActiveNotePath;
        const current = this.app.workspace.getActiveFile()?.path ?? null;
        this.lastActiveNotePath = current;
        if (prev && prev !== current) {
          void this.checkNoteForChanges(prev);
        }
        if (current && current === this.remindedNotePath) {
          this.clearChangeReminder();
        }
      })
    );
    // Also treat window blur (switching to another app) as a breakpoint.
    this.registerDomEvent(window, "blur", () => {
      const current = this.app.workspace.getActiveFile();
      if (current) void this.checkNoteForChanges(current.path);
    });

    // Initial outdated-chapters refresh: re-surfaces the badge after a restart
    // ("travelled back from a trip") as long as stale chapters remain persisted.
    void this.refreshStaleBadge();
  }

  onunload(): void {
    // Stop the background poll loop from touching a disposed plugin.
    this.batchTask = null;
    this.singleTask = null;
    this.batchStatusItem = null;
    this.staleStatusItem = null;
    this.changeReminderStatusItem = null;
    this.lastActiveNotePath = null;
    this.remindedNotePath = null;
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

  private contentCachePath(): string {
    return `${this.app.vault.configDir}/plugins/${this.manifest.id}/content-cache.json`;
  }

  private async loadContentCache(): Promise<void> {
    try {
      const raw = await this.app.vault.adapter.read(this.contentCachePath());
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string" && v.trim()) this.contentCache.set(k, v);
        }
      }
    } catch {
      // no cache yet, or unreadable — start empty
    }
  }

  private async persistContentCache(): Promise<void> {
    try {
      const obj: Record<string, string> = {};
      for (const [k, v] of this.contentCache) obj[k] = v;
      await this.app.vault.adapter.write(
        this.contentCachePath(),
        JSON.stringify(obj)
      );
    } catch (e) {
      console.error("[Penseed] Failed to persist content cache", e);
    }
  }

  private getRememberedContent(notePath: string): string {
    return this.contentCache.get(notePath) ?? "";
  }

  private rememberContent(notePath: string, content: string): void {
    const trimmed = (content ?? "").trim();
    if (!notePath || !trimmed) return;
    // refresh insertion order so this becomes most-recent, then evict oldest
    if (this.contentCache.has(notePath)) this.contentCache.delete(notePath);
    this.contentCache.set(notePath, trimmed);
    while (this.contentCache.size > PenseedPlugin.MAX_CONTENT_CACHE) {
      const oldest = this.contentCache.keys().next().value;
      if (oldest === undefined) break;
      this.contentCache.delete(oldest);
    }
    void this.persistContentCache();

    // Phase 0.23: re-analysis just committed this note's content, so its
    // edit-reminder (if any) is now stale — clear it.
    if (notePath === this.remindedNotePath) {
      this.clearChangeReminder();
    }
  }

  // ---- Phase 0.23: edit-reminder helpers ----

  private async checkNoteForChanges(notePath: string): Promise<void> {
    if (!notePath) return;
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile) || file.extension !== "md") return;
    if (
      this.singleTask?.status === "running" ||
      this.batchTask?.status === "running"
    ) {
      return;
    }
    const oldContent = this.getRememberedContent(notePath);
    if (!oldContent) return;

    let current: string;
    try {
      current = await this.app.vault.read(file);
    } catch {
      return;
    }
    const currentTrimmed = current.trim();
    const oldTrimmed = oldContent.trim();
    if (!currentTrimmed || currentTrimmed === oldTrimmed) return;

    const changedChars = diffChangedChars(oldTrimmed, currentTrimmed);
    const totalChars = currentTrimmed.length;
    const minChars = this.settings.changeReminderMinChars;
    const ratio = this.settings.changeReminderRatioPct / 100;
    const threshold = Math.max(minChars, totalChars * ratio);
    if (changedChars > threshold) {
      this.showChangeReminder(notePath);
    }
  }

  private showChangeReminder(notePath: string): void {
    this.remindedNotePath = notePath;
    if (this.changeReminderStatusItem) {
      this.changeReminderStatusItem.textContent =
        "Penseed: note changed — re-analyze?";
      this.changeReminderStatusItem.setAttribute(
        "title",
        `"${notePath}" was edited after its last analysis. Click to re-analyze, right-click to dismiss.`
      );
      this.changeReminderStatusItem.show();
    }
    notify(
      "Note changed since last analysis — re-analyze to stay consistent."
    );
  }

  private clearChangeReminder(): void {
    this.remindedNotePath = null;
    if (this.changeReminderStatusItem) {
      this.changeReminderStatusItem.hide();
    }
  }

  private async openNoteAndAnalyze(notePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) return;
    await this.app.workspace.getLeaf().openFile(file);
    await this.analyzeCurrentNote();
  }

  private async analyzeCurrentNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      notify("Please open a Markdown note first.");
      return;
    }

    const token = await this.auth.getAccessToken();
    if (!token) {
      notify("Please connect to Penseed in Settings first.");
      return;
    }

    const apiUrl = this.settings.apiUrl;

    let content: string;
    try {
      content = await this.app.vault.read(file);
    } catch (e) {
      notify("Penseed analysis failed.");
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
        notify("You don't have any projects yet. Create one at Penseed first.");
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
          projectId,
          file.path,
          this.getRememberedContent(file.path)
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
        onSave: async (selection) => {
          await this.saveReviewSelections(
            apiUrl,
            token,
            projectId,
            chapter.id,
            chapterNumber,
            selection
          );
          // Phase 0.22: cache the just-analyzed content so the chapter's FIRST
          // edit→re-analyze cycle can reuse it as the semantic gate's old text.
          this.rememberContent(file.path, content);
        },
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
        notify("Failed to save elements.");
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
      notify(`Penseed: ${parts.join(", ")}.${suffix}`);
    } else {
      notify(saved > 0 ? `Saved ${saved} foreshadowing.` : "Saved.");
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
    projectId: number,
    notePath: string,
    previousContent: string
  ): Promise<void> {
    if (
      this.singleTask?.status === "running" ||
      this.batchTask?.status === "running"
    ) {
      notify("A re-analysis is already running. Wait for it to finish.");
      return;
    }

    const started = await withRetry(() =>
      startSingleReanalysis(apiUrl, token, chapter.id, content, previousContent)
    );

    this.singleTask = {
      taskId: started.task_id,
      projectId,
      chapterId: chapter.id,
      notePath,
      content,
      status: "running",
      error: null,
      result: null,
    };

    this.renderStatus();
    notify(
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

    if (task.status === "completed") {
      await this.renderSingleReanalysisResult(task);
      void this.refreshStaleBadge();
    } else if (task.status === "error") {
      notify(task.error || "Single-chapter re-analysis failed.");
    } else if (task.status === "cancelled") {
      notify("Single-chapter re-analysis cancelled.");
    }

    // 完成后清空任务引用，避免状态栏残留旧的完成信息（单章/批量共用同一状态栏条目）。
    if (this.singleTask === task) {
      this.singleTask = null;
      this.renderStatus();
    }
  }

  private async renderSingleReanalysisResult(
    task: SingleReanalysisTaskState
  ): Promise<void> {
    const result = task.result;
    if (!result) {
      notify("Re-analysis completed but returned no result.");
      return;
    }

    // Phase 0.22: the server just committed this chapter's content (hash + gate),
    // so cache it as the "last-analyzed" text for the next edit→re-analyze cycle.
    this.rememberContent(task.notePath, task.content);

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
      noopReason: result.noop_reason ?? undefined,
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
      notify("A single-chapter re-analysis is already running.");
      return;
    }
    if (this.batchTask?.status === "running") {
      notify("A batch re-analysis is already running.");
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

    // Resume-only: submit chapters that are still stale. Already-processed
    // chapters have stale=False and are filtered out, so the backend's total
    // quota precheck doesn't double-count their credits (when stale info is
    // missing we conservatively submit the full set).
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
        payload.push({
          chapter_id: id,
          content,
          previous_content: this.getRememberedContent(note.path),
        });
      } catch (e) {
        console.error("[Penseed] Failed to read note for chapter", id, e);
        skippedNoNote++;
      }
    }

    if (payload.length === 0) {
      notify(
        "No chapters to re-analyze (all up to date, or local notes not found)."
      );
      return;
    }

    const started = await withRetry(() =>
      startReanalysisBatch(apiUrl, token, projectId, payload)
    );

    this.batchTask = {
      taskId: started.task_id,
      projectId,
      total: started.total ?? payload.length,
      completed: 0,
      failed: 0,
      currentChapterNumber: null,
      status: "running",
      error: null,
      converged: null,
      newStaleChapterIds: [],
      skippedNoNote,
      currentWave: null,
      totalWaves: null,
      stoppedByLimit: null,
      stoppedReason: null,
      remainingStaleCount: null,
    };

    this.renderStatus();
    notify(
      "Batch re-analysis submitted. It runs in the background — check the status bar for progress."
    );
    void this.pollBatchTaskInBackground();
  }

  private async pollBatchTaskInBackground(
    statusFetcher: (
      apiUrl: string,
      token: string,
      taskId: string
    ) => Promise<{
      status: string;
      total: number;
      completed: number;
      failed: number;
      current_chapter: number | null;
      current_wave?: number | null;
      credits_used?: number | null;
      error: string | null;
      result?: {
        converged: boolean;
        new_stale_chapter_ids: number[];
        total_waves?: number;
        stopped_by_limit?: boolean;
        stopped_reason?: "converged" | "limit" | "no_content" | "cancelled";
        remaining_stale_count?: number;
        credits_used?: number;
      } | null;
    }> = getReanalysisBatchStatus
  ): Promise<void> {
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
          statusFetcher(apiUrl, token, task.taskId)
        );

        task.total = status.total ?? task.total;
        task.completed = status.completed ?? 0;
        task.failed = status.failed ?? 0;
        task.currentChapterNumber = status.current_chapter ?? null;
        task.currentWave = status.current_wave ?? null;

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
          task.totalWaves = status.result?.total_waves ?? null;
          task.stoppedByLimit = status.result?.stopped_by_limit ?? null;
          task.stoppedReason = status.result?.stopped_reason ?? null;
          task.remainingStaleCount = status.result?.remaining_stale_count ?? null;
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

    this.notifyBatchFinished(task);
    void this.refreshStaleBadge();

    // 完成后清空任务引用，避免状态栏残留旧的完成信息（单章/批量共用同一状态栏条目）。
    if (this.batchTask === task) {
      this.batchTask = null;
      this.renderStatus();
    }
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
      this.batchStatusItem.createSpan({ text: "Re-analyzing…" });
      this.batchStatusItem.setAttribute(
        "title",
        "Single-chapter re-analysis in progress"
      );
    } else if (task.status === "completed") {
      setIcon(icon, "check-circle");
      this.batchStatusItem.createSpan({ text: "Re-analysis complete" });
      this.batchStatusItem.setAttribute(
        "title",
        "Single-chapter re-analysis complete"
      );
    } else if (task.status === "error") {
      setIcon(icon, "alert-circle");
      this.batchStatusItem.createSpan({ text: "Re-analysis failed" });
      this.batchStatusItem.setAttribute(
        "title",
        task.error || "Single-chapter re-analysis failed"
      );
    } else {
      setIcon(icon, "ban");
      this.batchStatusItem.createSpan({ text: "Re-analysis cancelled" });
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
      const text =
        task.currentWave != null && task.currentWave > 1
          ? `Re-analyzing wave ${task.currentWave}…`
          : `Re-analyzing ${completed}/${total}`;
      this.batchStatusItem.createSpan({ text });
      this.batchStatusItem.setAttribute(
        "title",
        "Batch re-analysis in progress — click for details"
      );
    } else if (task.status === "completed") {
      setIcon(icon, "check-circle");
      this.batchStatusItem.createSpan({
        text: `Re-analysis done: ${task.completed} chapters`,
      });
      this.batchStatusItem.setAttribute(
        "title",
        "Batch re-analysis complete — click for results"
      );
    } else if (task.status === "error") {
      setIcon(icon, "alert-circle");
      this.batchStatusItem.createSpan({ text: "Re-analysis failed" });
      this.batchStatusItem.setAttribute(
        "title",
        task.error || "Batch re-analysis failed"
      );
    } else {
      setIcon(icon, "ban");
      this.batchStatusItem.createSpan({ text: "Re-analysis cancelled" });
    }
  }

  private notifyBatchFinished(task: ReanalysisBatchTaskState): void {
    if (task.status === "completed") {
      const waves = `${task.totalWaves ?? 1} wave${(task.totalWaves ?? 1) === 1 ? "" : "s"}`;
      if (task.stoppedReason === "limit") {
        notify(
          `Sync stopped at the safety limit after ${waves} — ${
            task.remainingStaleCount ?? 0
          } chapters still need review. (Edit them, or raise max_waves.)`
        );
        return;
      }
      if (task.stoppedReason === "no_content") {
        notify(
          `Sync done, but ${
            task.remainingStaleCount ?? 0
          } chapters are still outdated — re-paste their text to finish.`
        );
        return;
      }
      if (task.stoppedReason === "converged") {
        notify(`Sync complete — converged after ${waves}. All chapters are up to date.`);
        return;
      }
      // 手动「Batch re-analyze outdated chapters」路径（无级联富结果）。
      const parts: string[] = [`Re-analysis done: ${task.completed} chapters`];
      if (task.skippedNoNote > 0) {
        parts.push(`${task.skippedNoNote} skipped (no local note)`);
      }
      if (task.failed > 0) {
        parts.push(`${task.failed} failed`);
      }
      notify(parts.join(", ") + ".");
    } else if (task.status === "error") {
      notify(task.error || "Batch re-analysis failed.");
    } else if (task.status === "cancelled") {
      notify("Batch re-analysis cancelled.");
    }
  }

  private openBatchProgressModal(): void {
    if (!this.batchTask) {
      notify("No batch re-analysis task in progress.");
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
      notify("Open a note first.");
      return;
    }
    const token = await this.auth.getAccessToken();
    if (!token) {
      notify("Please connect to Penseed in Settings first.");
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
      notify("You don't have any projects yet. Create one at Penseed first.");
      return;
    }
    const folderPath = file.parent?.path ?? "";
    const chosen = await this.chooseProject(projects);
    if (chosen === null) return;
    this.settings.folderProjectMap[folderPath] = chosen.id;
    this.settings.lastProjectId = chosen.id;
    await this.saveSettings();
    notify(`"${folderPath || "Vault root"}" now maps to "${chosen.title}".`);
  }

  private resolveFolderForProject(projectId: number): string | null {
    for (const [folder, id] of Object.entries(this.settings.folderProjectMap)) {
      if (id === projectId) return folder;
    }
    return null;
  }

  private collectManuscriptFiles(projectId: number): {
    files: TFile[];
    classified: ClassifiedFile[];
  } {
    const folderPath = this.resolveFolderForProject(projectId);
    if (folderPath === null) {
      throw new Error("No folder mapped for this project");
    }
    // 目录边界：folder "MOBY-DICK" 不得误纳 "MOBY-DICK-3-for-test" 的子文件。
    const prefix = folderPath === "" ? "" : folderPath + "/";
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(prefix));
    const inputs = files.map((f) => ({
      path: f.path,
      basename: f.basename,
      number: extractChapterNumber(f.basename),
    }));
    const excludePaths =
      this.settings.chapterRules[projectId]?.excludePaths ?? [];
    // 信号 2（文件夹密度）：低密度一级子文件夹建议排除，供预览勾选「记住排除」持久化。
    const lowDensity = detectLowDensityFolders(
      files.map((f) => f.path),
      folderPath
    );
    const mergedExcludes = [
      ...excludePaths,
      ...lowDensity.filter((d) => !excludePaths.includes(d)),
    ];
    const classified = classifyManuscriptFiles(
      inputs,
      mergedExcludes,
      folderPath
    );
    return { files, classified };
  }

  private async buildManuscriptChapters(
    files: TFile[],
    classified: ClassifiedFile[],
    includedPaths: Set<string>
  ): Promise<BatchSyncChapterInput[][]> {
    const keptFiles = files.filter((_, i) =>
      includedPaths.has(classified[i].path)
    );
    const kept = classified.filter((c) => includedPaths.has(c.path));
    const assigned = assignPluginChapterNumbers(
      kept.map((c) => ({ basename: c.basename, number: c.number }))
    );
    const chapters: BatchSyncChapterInput[] = [];
    for (let i = 0; i < keptFiles.length; i++) {
      const content = await this.app.vault.read(keptFiles[i]);
      chapters.push({
        chapter_number: assigned[i].number,
        title: keptFiles[i].basename,
        content,
      });
    }
    const chunks: BatchSyncChapterInput[][] = [];
    for (let i = 0; i < chapters.length; i += 100) {
      chunks.push(chapters.slice(i, i + 100));
    }
    return chunks;
  }

  private async syncManuscript(): Promise<void> {
    const { apiUrl } = this.settings;
    const token = await this.auth.getAccessToken();
    if (!token) {
      notify("Please connect to Penseed in Settings first.");
      return;
    }
    // 先问用户 sync 哪个项目：多项目 vault 下 lastProjectId 静默决定会把不同项目的章节混在一起。
    let projects: PenseedProject[];
    try {
      projects = await listProjects(apiUrl, token);
    } catch (e) {
      this.notifyError(e);
      return;
    }
    if (projects.length === 0) {
      notify("You don't have any projects yet. Create one at Penseed first.");
      return;
    }
    const chosen = await this.chooseProject(
      projects,
      this.settings.lastProjectId
    );
    if (chosen === null) return;
    const projectId = chosen.id;
    this.settings.lastProjectId = projectId;
    await this.saveSettings();

    // 该项目必须已关联 vault 文件夹，否则无法定位章节范围。
    if (this.resolveFolderForProject(projectId) === null) {
      notify(
        `"${chosen.title}" isn't linked to a folder in this vault yet. ` +
          `Open one of its chapter notes and analyze it once, or run ` +
          `"Change project for this note's folder".`
      );
      return;
    }

    // 0) 分类（廉价，不读内容）→ 预览确认 D
    let collected: { files: TFile[]; classified: ClassifiedFile[] };
    try {
      collected = this.collectManuscriptFiles(projectId);
    } catch (e) {
      notify(
        e instanceof Error
          ? e.message
          : "No folder mapped for this project."
      );
      return;
    }
    const { files, classified } = collected;
    if (files.length === 0) {
      notify("No markdown notes found in the project folder.");
      return;
    }

    const confirmed = await this.confirmClassification(classified);
    if (!confirmed) return;
    const { includedPaths, persistExcludes } = confirmed;
    if (persistExcludes.length > 0) {
      this.settings.chapterRules[projectId] = { excludePaths: persistExcludes };
      await this.saveSettings();
    }

    const chunks = await this.buildManuscriptChapters(
      files,
      classified,
      includedPaths
    );
    if (chunks.length === 0) {
      notify("No chapters selected.");
      return;
    }

    try {
      // 1) 分片上传：首片 jobId=null 建 job，末片 isLast=true 置 ready
      let jobId: string | null = null;
      for (let i = 0; i < chunks.length; i++) {
        const res = await withRetry(() =>
          uploadBatchSyncChunk(
            apiUrl,
            token,
            projectId,
            jobId,
            i,
            i === chunks.length - 1,
            chunks[i]
          )
        );
        jobId = res.job_id;
      }

      // 2) 预览分类（零 LLM）：new/unchanged/changed + 漂移提示 + 配额估算
      const preview = await withRetry(() =>
        previewBatchSyncJob(apiUrl, token, projectId, jobId!)
      );

      // 3) 用户确认；取消则中止 job
      const ok = await this.confirmSyncPreview(preview);
      if (!ok) {
        await withRetry(() => cancelBatchSyncJob(apiUrl, token, jobId!));
        return;
      }

      // 4) 启动同步（task_id == job_id）+ 复用轮询
      const started = await withRetry(() =>
        startBatchSyncJob(apiUrl, token, projectId, jobId!)
      );
      this.batchTask = {
        taskId: started.task_id,
        projectId,
        total: started.total ?? 0,
        completed: 0,
        failed: 0,
        currentChapterNumber: null,
        status: "running",
        error: null,
        converged: null,
        newStaleChapterIds: [],
        skippedNoNote: 0,
        currentWave: null,
        totalWaves: null,
        stoppedByLimit: null,
        stoppedReason: null,
        remainingStaleCount: null,
      };
      this.renderStatus();
      notify(
        "Manuscript sync started. It runs in the background — check the status bar for progress."
      );
      void this.pollBatchTaskInBackground(getBatchAnalysisStatus);
    } catch (e) {
      this.notifyError(e);
    }
  }

  private confirmClassification(
    classified: ClassifiedFile[]
  ): Promise<{ includedPaths: Set<string>; persistExcludes: string[] } | null> {
    return new Promise((resolve) => {
      new ClassificationModal(this.app, classified, resolve).open();
    });
  }

  private confirmSyncPreview(preview: BatchSyncPreview): Promise<boolean> {
    return new Promise((resolve) => {
      new SyncPreviewModal(this.app, preview, resolve).open();
    });
  }

  private chooseProject(
    projects: PenseedProject[],
    preferredId?: number | null
  ): Promise<PenseedProject | null> {
    return new Promise((resolve) => {
      new ProjectSuggestModal(this.app, projects, resolve, preferredId).open();
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
      notify(e.userMessage);
    } else {
      notify("Penseed analysis failed.");
    }
    console.error("[Penseed]", e);
  }

  private async refreshStaleBadge(): Promise<void> {
    const item = this.staleStatusItem;
    if (!item) return;

    const projectId = this.settings.lastProjectId;
    if (!projectId) {
      this.staleChapterIds = [];
      item.hide();
      return;
    }

    const token = await this.auth.getAccessToken();
    if (!token) {
      this.staleChapterIds = [];
      item.hide();
      return;
    }

    let chapters: PenseedChapter[];
    try {
      chapters = await listChapters(this.settings.apiUrl, token, projectId);
    } catch (e) {
      // 拉取失败不打扰用户；保留当前徽章状态，下次成功时刷新。
      return;
    }

    this.staleChapterIds = staleChapterIds(chapters);
    if (this.staleChapterIds.length === 0) {
      item.hide();
      return;
    }

    item.empty();
    const icon = item.createSpan({ cls: "penseed-stale-badge-icon" });
    setIcon(icon, "alert-triangle");
    item.createSpan({ text: staleBadgeText(this.staleChapterIds.length) });
    item.setAttribute(
      "title",
      "Click to see which chapters are out of date and re-analyze them."
    );
    item.show();
  }

  private async openOutdatedChaptersModal(): Promise<void> {
    const projectId = this.settings.lastProjectId;
    if (!projectId) return;
    const apiUrl = this.settings.apiUrl;
    const token = await this.auth.getAccessToken();
    if (!token) return;

    let chapters: PenseedChapter[];
    try {
      chapters = await listChapters(apiUrl, token, projectId);
    } catch (e) {
      this.notifyError(e);
      return;
    }

    const noteTitleByNumber = new Map<number, string>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const n = extractChapterNumber(f.basename);
      if (n !== null) noteTitleByNumber.set(n, f.basename);
    }

    const items = mapStaleToDisplay(chapters, noteTitleByNumber);
    if (items.length === 0) {
      notify("No outdated chapters.");
      return;
    }

    const ids = staleChapterIds(chapters);
    new OutdatedChaptersModal(this.app, items, () =>
      this.batchReanalyze(apiUrl, token, projectId, ids)
    ).open();
  }
}
