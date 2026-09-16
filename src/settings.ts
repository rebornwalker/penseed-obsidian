import { App, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type PenseedPlugin from "./main";

export interface PenseedSettings {
  apiUrl: string;
  // Name of the secret stored in Obsidian's SecretStorage (not the token value itself).
  tokenSecretName: string;
  lastProjectId: number | null;
}

export const DEFAULT_SETTINGS: PenseedSettings = {
  apiUrl: "https://api.penseed.app",
  tokenSecretName: "",
  lastProjectId: null,
};

export class PenseedSettingTab extends PluginSettingTab {
  plugin: PenseedPlugin;

  constructor(app: App, plugin: PenseedPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Penseed API URL")
      .setDesc("Default: https://api.penseed.app")
      .addText((text) =>
        text
          .setPlaceholder("https://api.penseed.app")
          .setValue(this.plugin.settings.apiUrl)
          .onChange(async (value) => {
            this.plugin.settings.apiUrl =
              value.trim() || DEFAULT_SETTINGS.apiUrl;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Penseed access token")
      .setDesc(
        "Sign in to Penseed, copy your access token, and save it here. " +
          "The token expires after ~60 minutes and must be re-pasted."
      )
      .addComponent(
        (el) =>
          new SecretComponent(this.app, el)
            .setValue(this.plugin.settings.tokenSecretName)
            .onChange((value) => {
              this.plugin.settings.tokenSecretName = value;
              this.plugin.saveSettings();
            })
      );
  }
}
