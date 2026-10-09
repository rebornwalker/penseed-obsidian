import { Notice } from "obsidian";

/**
 * Unified toast with a longer default duration (15s = 3× Obsidian's 5s default)
 * so authors can actually read messages before they vanish.
 *
 * Phase 0.23 — every transient notice routes through here. The one exception is
 * the "Analyzing with Penseed..." loading indicator, which keeps `durationMs=0`
 * (persistent until explicitly hidden) in main.ts.
 */
export function notify(message: string, durationMs = 15000): Notice {
  return new Notice(message, durationMs);
}
