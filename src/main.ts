import { Notice, Plugin, SuggestModal } from "obsidian";
import {
  PenseedSettings,
  PenseedSettingTab,
  DEFAULT_SETTINGS,
} from "./settings";
import {
  ApiError,
  listProjects,
  createChapter,
  extractForeshadowing,
  extractEntities,
  listForeshadowings,
  saveForeshadowing,
  saveEntities,
  PenseedProject,
} from "./api";
import { AnalysisResultModal } from "./ui";
import { PenseedAuthManager } from "./auth";

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

    this.addCommand({
      id: "analyze-current-note",
      name: "Analyze Current Note",
      callback: () => this.analyzeCurrentNote(),
    });
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
      const chapter = await createChapter(
        apiUrl,
        token,
        projectId,
        file.basename,
        extractChapterNumber(file.basename),
        smartWordCount(content)
      );

      const foreshadowing = await extractForeshadowing(
        apiUrl,
        token,
        projectId,
        chapter.id,
        content
      );

      // 按章节去重：先取该章已有伏笔，跳过重复的候选
      const existing = await listForeshadowings(apiUrl, token, chapter.id, projectId);
      const existingPreviews = new Set(
        (existing.items ?? [])
          .map((f) => (f.foreshadowing_text_preview ?? "").trim())
          .filter((s) => s.length > 0)
      );

      let savedForeshadowing = 0;
      let skippedForeshadowing = 0;
      for (const c of foreshadowing.candidates) {
        const preview = (c.foreshadowing_text_preview ?? c.text ?? "").trim();
        if (!preview) continue;
        if (existingPreviews.has(preview)) {
          skippedForeshadowing++;
          continue;
        }
        try {
          await saveForeshadowing(apiUrl, token, {
            project_id: projectId,
            chapter_id: chapter.id,
            foreshadowing_text_preview: preview,
            confidence: c.confidence ?? 0,
            start_position: c.start_position ?? -1,
            end_position: c.end_position ?? -1,
            is_foreshadowing: c.is_foreshadowing ?? true,
            foreshadowing_type: c.foreshadowing_type ?? null,
            target_elements: c.target_elements ?? null,
            emotional_tone: c.emotional_tone ?? null,
            narrative_function: c.narrative_function ?? null,
            analysis: c.analysis ?? null,
            improvement_suggestions: c.improvement_suggestions ?? null,
          });
          existingPreviews.add(preview);
          savedForeshadowing++;
        } catch (e) {
          console.error("[Penseed] Failed to save foreshadowing candidate", e);
        }
      }

      const entities = await extractEntities(apiUrl, token, projectId, content);
      let savedEntities = 0;
      if (entities.entities && entities.entities.length > 0) {
        const res = await saveEntities(apiUrl, token, {
          project_id: projectId,
          chapter_id: chapter.id,
          chapter_number: chapter.chapter_number ?? null,
          entities: entities.entities,
        });
        savedEntities = res.saved_count ?? entities.entities.length;
      }

      notice.hide();

      new AnalysisResultModal(this.app, {
        foreshadowingCount: savedForeshadowing,
        foreshadowingSkipped: skippedForeshadowing,
        entityCount: savedEntities,
        projectId,
      }).open();
    } catch (e) {
      notice.hide();
      this.notifyError(e);
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
