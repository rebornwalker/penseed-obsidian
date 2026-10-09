import { App, PluginSettingTab } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type PenseedPlugin from "./main";
import { notify } from "./notify";

export interface PenseedSettings {
  apiUrl: string;
  lastProjectId: number | null;
  folderProjectMap: Record<string, number>;
  changeReminderMinChars: number;
  changeReminderRatioPct: number;
}

export const DEFAULT_SETTINGS: PenseedSettings = {
  apiUrl: "https://api.penseed.app",
  lastProjectId: null,
  folderProjectMap: {},
  changeReminderMinChars: 50,
  changeReminderRatioPct: 1,
};

export class PenseedSettingTab extends PluginSettingTab {
  plugin: PenseedPlugin;
  private connecting = false;

  constructor(app: App, plugin: PenseedPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // Phase 0.23: bind declarative `control` settings to the plugin's settings
  // object, so the reminder threshold number inputs persist like everything else.
  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  setControlValue(key: string, value: unknown): void {
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
    void this.plugin.saveSettings();
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const reminderSettings: SettingDefinitionItem[] = [
      {
        name: "Re-analysis reminder — minimum change (chars)",
        desc:
          "When you edit an analyzed note and leave it, Penseed suggests " +
          "re-analysis only if the change exceeds this many characters AND the " +
          "ratio below. Small typo/punctuation edits stay under this bar.",
        control: {
          type: "number",
          key: "changeReminderMinChars",
          defaultValue: 50,
          min: 0,
          max: 10000,
          step: 1,
        },
      },
      {
        name: "Re-analysis reminder — change ratio (%)",
        desc:
          "Also require the change to exceed this percentage of the note's " +
          "length. Combined with the minimum above — both must be met before " +
          "the reminder appears.",
        control: {
          type: "number",
          key: "changeReminderRatioPct",
          defaultValue: 1,
          min: 0,
          max: 100,
          step: 1,
        },
      },
    ];

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
        ...reminderSettings,
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
      ...reminderSettings,
    ];
  }

  private async connect(): Promise<void> {
    this.connecting = true;
    this.update();
    try {
      const email = await this.plugin.auth.connect();
      notify(`Connected to Penseed${email ? ` as ${email}` : ""}.`);
    } catch (e) {
      notify(e instanceof Error ? e.message : "Sign-in failed.");
    } finally {
      this.connecting = false;
      this.update();
    }
  }

  private async disconnect(): Promise<void> {
    await this.plugin.auth.disconnect();
    notify("Disconnected from Penseed.");
    this.update();
  }
}
