import type { PenseedChapter } from "./api";

// 插件端「过时章」纯函数：把 listChapters 返回的章列表里的 stale 章抽出，
// 供状态栏徽章计数与 OutdatedChaptersModal 展示。无 IO、无副作用，便于 npx tsx 验证。
export interface StaleDisplayItem {
  chapterNumber: number | null;
  noteTitle: string | null;
}

const NO_NUMBER = Number.MAX_SAFE_INTEGER;

function sortedStale(chapters: PenseedChapter[]): PenseedChapter[] {
  return chapters
    .filter((c) => c.stale === true)
    .sort((a, b) => {
      const an = a.chapter_number ?? NO_NUMBER;
      const bn = b.chapter_number ?? NO_NUMBER;
      return an - bn;
    });
}

export function staleChapterIds(chapters: PenseedChapter[]): number[] {
  return sortedStale(chapters).map((c) => c.id);
}

export function staleBadgeText(count: number): string {
  return `${count} outdated chapter${count === 1 ? "" : "s"}`;
}

export function mapStaleToDisplay(
  chapters: PenseedChapter[],
  noteTitleByNumber: Map<number, string>
): StaleDisplayItem[] {
  return sortedStale(chapters).map((c) => {
    const n = c.chapter_number;
    return {
      chapterNumber: n ?? null,
      noteTitle: typeof n === "number" ? (noteTitleByNumber.get(n) ?? null) : null,
    };
  });
}
