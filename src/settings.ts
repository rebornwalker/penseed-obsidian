import { App, Notice, PluginSettingTab } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type PenseedPlugin from "./main";

export interface PenseedSettings {
  apiUrl: string;
  lastProjectId: number | null;
}

export const DEFAULT_SETTINGS: PenseedSettings = {
  apiUrl: "https://api.penseed.app",
  lastProjectId: null,
};

export class PenseedSettingTab extends PluginSettingTab {
  plugin: PenseedPlugin;
  private connecting = false;

  constructor(app: App, plugin: PenseedPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    if (this.plugin.auth.isConnected()) {
      const email = this.plugin.auth.getEmail();
      return [
        {
          name: "Disconnect from Penseed",
          desc: email ? `Signed in as ${email}` : "Signed in to Penseed.",
          action: () => {
            void this.disconnect();
          },
        },
      ];
    }

    return [
      {
        name: this.connecting
          ? "Waiting for authorization..."
          : "Connect to Penseed",
        desc:
          "Sign in to Penseed in your browser to enable note analysis. " +
          "No token copy-paste needed.",
        disabled: () => this.connecting,
        action: () => {
          void this.connect();
        },
      },
    ];
  }

  private async connect(): Promise<void> {
    this.connecting = true;
    this.update();
    try {
      const email = await this.plugin.auth.connect();
      new Notice(`Connected to Penseed${email ? ` as ${email}` : ""}.`);
    } catch (e) {
      new Notice(e instanceof Error ? e.message : "Sign-in failed.");
    } finally {
      this.connecting = false;
      this.update();
    }
  }

  private async disconnect(): Promise<void> {
    await this.plugin.auth.disconnect();
    new Notice("Disconnected from Penseed.");
    this.update();
  }
}
