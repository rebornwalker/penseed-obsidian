import { Notice, Plugin, SuggestModal, TFile } from "obsidian";
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
  reanalyzeChapter,
  extractForeshadowing,
  extractEntities,
  saveForeshadowing,
  saveEntities,
  analyzeChapterResolution,
  updateForeshadowingStatus,
  PenseedProject,
} from "./api";
import { ReanalysisResultModal, ReplayItem } from "./ui";
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
  const arabic = filename.match(/\d+/);
  if (arabic) return parseInt(arabic[0], 10);

  const chinese = filename.match(/第([零〇一二两三四五六七八九十百千万]+)[章回节卷部]/);
  if (chinese) {
    const value = chineseToNumber(chinese[1]);
    if (value !== null) return value;
  }
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

export default class PenseedPlugin extends Plugin {
  settings!: PenseedSettings;
  auth!: PenseedAuthManager;

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

    // Resolve the target project (reuse the last selection when still valid).
    let projectId: number;
    try {
      const projects = await listProjects(apiUrl, token);
      if (projects.length === 0) {
        new Notice("You don't have any projects yet. Create one at Penseed first.");
        return;
      }
      const remembered = this.settings.lastProjectId;
      if (remembered !== null && projects.some((p) => p.id === remembered)) {
        projectId = remembered;
      } else {
        const chosen = await this.chooseProject(projects);
        if (chosen === null) return;
        projectId = chosen.id;
        this.settings.lastProjectId = projectId;
        await this.saveSettings();
      }
    } catch (e) {
      this.notifyError(e);
      return;
    }

    const notice = new Notice("Analyzing with Penseed...", 0);

    try {
      // get_or_create the chapter by chapter_number. `isNew` (201 vs 200) is the
      // branch point: a brand-new chapter goes through extract → review → save,
      // while an existing chapter (edited historical text) re-runs in place.
      const { chapter, isNew } = await createChapter(
        apiUrl,
        token,
        projectId,
        file.basename,
        extractChapterNumber(file.basename),
        smartWordCount(content),
        content
      );

      if (!isNew) {
        // Historical chapter: recompute in place, auto-commit, flag downstream.
        const result = await reanalyzeChapter(apiUrl, token, chapter.id, content);
        notice.hide();

        const affected = await this.buildReplayItems(
          apiUrl,
          token,
          projectId,
          result.affected_downstream_chapters
        );

        new ReanalysisResultModal(this.app, {
          entityCount: result.entity_count,
          foreshadowingCount: result.foreshadowing_count,
          addedForeshadowings: result.added_foreshadowings,
          deletedForeshadowings: result.deleted_foreshadowings,
          semanticChangedCount: result.semantic_changed_count,
          resolvedCount: result.foreshadowings_resolved,
          estimatedReplayCredits: result.estimated_replay_credits,
          projectId,
          affected,
          isFirstAnalysis: false,
        }).open();
        return;
      }

      // New chapter: extract candidates and entities without committing, run
      // resolution analysis, then let the author pick what to keep.
      const chapterNumber =
        chapter.chapter_number ?? extractChapterNumber(file.basename);

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
    let saved = 0;
    let failed = 0;

    for (const candidate of selection.candidates) {
      const text = candidate.foreshadowing_text_preview ?? candidate.text ?? "";
      if (!text.trim()) continue;
      try {
        await saveForeshadowing(apiUrl, token, {
          project_id: projectId,
          chapter_id: chapterId,
          foreshadowing_text_preview: text,
          confidence:
            typeof candidate.confidence === "number" ? candidate.confidence : 0.5,
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
          improvement_suggestions: candidate.improvement_suggestions ?? undefined,
        });
        saved++;
      } catch (e) {
        failed++;
        console.error("[Penseed] Failed to save foreshadowing", e);
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

    for (const id of selection.resolvedIds) {
      try {
        await updateForeshadowingStatus(apiUrl, token, id, "resolved");
      } catch (e) {
        console.error("[Penseed] Failed to mark foreshadowing resolved", e);
      }
    }

    if (failed > 0) {
      new Notice(`Saved ${saved} foreshadowing, ${failed} failed.`);
    } else {
      new Notice(saved > 0 ? `Saved ${saved} foreshadowing.` : "Saved.");
    }
  }

  private async buildReplayItems(
    apiUrl: string,
    token: string,
    projectId: number,
    affectedChapterIds: number[]
  ): Promise<ReplayItem[]> {
    if (affectedChapterIds.length === 0) return [];

    // Map chapter id → chapter_number.
    const numberById = new Map<number, number>();
    try {
      const chapters = await listChapters(apiUrl, token, projectId);
      for (const c of chapters) {
        if (typeof c.chapter_number === "number") {
          numberById.set(c.id, c.chapter_number);
        }
      }
    } catch (e) {
      console.error("[Penseed] Failed to list chapters for replay mapping", e);
    }

    // Map chapter_number → note file (by leading number in filename).
    const noteByNumber = new Map<number, TFile>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const n = extractChapterNumber(f.basename);
      if (n !== null) noteByNumber.set(n, f);
    }

    return affectedChapterIds.map((id) => {
      const chapterNumber = numberById.get(id);
      const note =
        chapterNumber !== undefined ? noteByNumber.get(chapterNumber) : undefined;
      return {
        chapterNumber: chapterNumber ?? id,
        noteTitle: note ? note.basename : null,
        onReplay: () =>
          this.replayChapterNote(apiUrl, token, projectId, note ?? null, id),
      };
    });
  }

  private async replayChapterNote(
    apiUrl: string,
    token: string,
    projectId: number,
    note: TFile | null,
    chapterId: number
  ): Promise<boolean> {
    if (!note) return false;
    try {
      const content = await this.app.vault.read(note);
      const { chapter } = await createChapter(
        apiUrl,
        token,
        projectId,
        note.basename,
        extractChapterNumber(note.basename),
        smartWordCount(content),
        content
      );
      await reanalyzeChapter(apiUrl, token, chapter.id, content);
      return true;
    } catch (e) {
      console.error("[Penseed] Failed to replay chapter", e);
      return false;
    }
  }

  private chooseProject(
    projects: PenseedProject[]
  ): Promise<PenseedProject | null> {
    return new Promise((resolve) => {
      new ProjectSuggestModal(this.app, projects, resolve).open();
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
