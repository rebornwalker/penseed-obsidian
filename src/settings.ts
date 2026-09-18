import { App, Notice, PluginSettingTab, Setting } from "obsidian";
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

  constructor(app: App, plugin: PenseedPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    if (this.plugin.auth.isConnected()) {
      const email = this.plugin.auth.getEmail();
      new Setting(containerEl)
        .setName("Connected to Penseed")
        .setDesc(email ? `Signed in as ${email}` : "Signed in to Penseed.")
        .addButton((button) =>
          button
            .setButtonText("Disconnect")
            .setWarning()
            .onClick(async () => {
              await this.plugin.auth.disconnect();
              new Notice("Disconnected from Penseed.");
              this.display();
            })
        );
    } else {
      new Setting(containerEl)
        .setName("Connect to Penseed")
        .setDesc(
          "Sign in to Penseed in your browser to enable note analysis. " +
            "No token copy-paste needed."
        )
        .addButton((button) =>
          button
            .setButtonText("Connect Penseed")
            .setCta()
            .onClick(async () => {
              button.setButtonText("Waiting for authorization...");
              button.setDisabled(true);
              try {
                const email = await this.plugin.auth.connect();
                new Notice(
                  `Connected to Penseed${email ? ` as ${email}` : ""}.`
                );
              } catch (e) {
                new Notice(
                  e instanceof Error ? e.message : "Sign-in failed."
                );
              } finally {
                this.display();
              }
            })
        );
    }
  }
}
