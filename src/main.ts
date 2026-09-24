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
  PenseedProject,
} from "./api";
import { ReanalysisResultModal, ReplayItem } from "./ui";
import { PenseedAuthManager } from "./auth";
import {
  ForeshadowingBoardView,
  VIEW_TYPE_FORESHADOWING_BOARD,
} from "./board";

function extractChapterNumber(filename: string): number | null {
  const match = filename.match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
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
    el.createEl("div", { text: project.title });
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
    setTimeout(() => {
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
      this.analyzeCurrentNote();
    });

    this.registerView(
      VIEW_TYPE_FORESHADOWING_BOARD,
      (leaf) => new ForeshadowingBoardView(leaf, this)
    );

    this.addRibbonIcon("layout-grid", "Open foreshadowing board", () => {
      this.activateBoardView();
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
      workspace.revealLeaf(existing);
      const view = existing.view;
      if (view instanceof ForeshadowingBoardView) view.refresh();
      return;
    }
    const leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
    await leaf.setViewState({
      type: VIEW_TYPE_FORESHADOWING_BOARD,
      active: true,
    });
    workspace.revealLeaf(leaf);
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
      // get_or_create the chapter, then recompute it in place. Reanalysis is
      // idempotent: a fresh chapter has no prior data to diff, so it behaves as
      // first-time analysis. The `isNew` flag (201 vs 200) drives the modal copy.
      const { chapter, isNew } = await createChapter(
        apiUrl,
        token,
        projectId,
        file.basename,
        extractChapterNumber(file.basename),
        smartWordCount(content)
      );

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
        isFirstAnalysis: isNew,
      }).open();
    } catch (e) {
      notice.hide();
      this.notifyError(e);
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
        smartWordCount(content)
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
