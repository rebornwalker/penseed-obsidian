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
  PenseedProject,
} from "./api";
import { AnalysisResultModal } from "./ui";

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
  private chosen = false;

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
    this.chosen = true;
    this.resolve(project);
  }

  onClose(): void {
    if (!this.chosen) {
      this.resolve(null);
    }
    super.onClose();
  }
}

export default class PenseedPlugin extends Plugin {
  settings: PenseedSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new PenseedSettingTab(this.app, this));

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

  private getToken(): string | null {
    const name = this.settings.tokenSecretName;
    if (!name) return null;
    return this.app.secretStorage.getSecret(name) || null;
  }

  private async analyzeCurrentNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("Please open a Markdown note first.");
      return;
    }

    const token = this.getToken();
    if (!token) {
      new Notice("Please sign in to Penseed in Settings.");
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

      const entities = await extractEntities(apiUrl, token, projectId, content);

      notice.hide();

      new AnalysisResultModal(this.app, {
        foreshadowingCount: foreshadowing.candidates.length,
        entityCount: entities.entity_count,
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
