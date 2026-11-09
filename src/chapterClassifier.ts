/**
 * chapterClassifier.ts — language-independent "chapter vs reference note"
 * classifier (Phase 0.37, scheme C+D).
 *
 * Three structural signals, ZERO keyword/word-list lookup, so it works for any
 * language the user writes in (English, Chinese, French, German, Japanese, ...):
 *   1. numbering majority — normalize digit runs to '#' and count patterns;
 *   2. folder density — first-level subfolders with few .md files are likely
 *      reference material (character sheets, world bible), suggested for exclusion;
 *   3. front/back position anchoring — unnumbered files sorted by basename and
 *      placed before/after numbered files.
 *
 * Anything still ambiguous falls through to the preview-confirm dialog (D).
 */

export interface ClassifierInput {
  path: string;
  basename: string;
  number: number | null;
}

export type Verdict = "chapter" | "excluded" | "needs-confirm";

export interface ClassifiedFile extends ClassifierInput {
  pattern: string;
  verdict: Verdict;
  defaultInclude: boolean; // used for the preview checkbox default when needs-confirm
}

// 信号 1（编号多数派）：连续数字归一化成 '#'，纯数字、零词表、语言无关
export function normalizePattern(basename: string): string {
  return basename.replace(/\d+/g, "#");
}

export function detectDominantNumberedPattern(basenames: string[]): string | null {
  const counts = new Map<string, number>();
  for (const b of basenames) {
    const p = normalizePattern(b);
    if (p.includes("#")) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [p, c] of counts) {
    if (c > bestCount) {
      best = p;
      bestCount = c;
    }
  }
  return best;
}

// 信号 2（文件夹密度）：项目文件夹下，含 .md 文件数 <= threshold 的一级子文件夹 → 建议排除。
// 返回完整路径（projectFolder 前缀），使其可直接作为 classifyManuscriptFiles 的 excludePaths 条目。
export function detectLowDensityFolders(
  paths: string[],
  projectFolder: string,
  threshold = 5
): string[] {
  const base = (projectFolder || "").replace(/\/+$/, "") + "/";
  const counts = new Map<string, number>();
  for (const p of paths) {
    if (!p.startsWith(base)) continue;
    const seg = p.slice(base.length).split("/");
    if (seg.length > 1) counts.set(seg[0], (counts.get(seg[0]) ?? 0) + 1);
  }
  const root = (projectFolder || "").replace(/\/+$/, "");
  return [...counts.entries()]
    .filter(([, c]) => c <= threshold)
    .map(([f]) => `${root}/${f}`);
}

// 信号 3（前后置位置锚定）：基于原始文件顺序（vault 枚举顺序，通常按路径/文件名排序），
// 判断无编号文件相对于有编号文件的位置——靠相对位置，不靠「序章/prologue」等词。
// 无编号文件位于第一个编号文件之前 → 'front'；最后一个之后 → 'back'；介于其间 → null。
function frontBackPosition(
  items: ClassifierInput[]
): Map<string, "front" | "back" | null> {
  const firstNumbered = items.findIndex((i) => i.number !== null);
  if (firstNumbered === -1) return new Map(items.map((f) => [f.path, null]));
  let lastNumbered = firstNumbered;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].number !== null) {
      lastNumbered = i;
      break;
    }
  }
  const pos = new Map<string, "front" | "back" | null>();
  items.forEach((f, i) => {
    if (f.number !== null) {
      pos.set(f.path, null);
      return;
    }
    pos.set(f.path, i < firstNumbered ? "front" : i > lastNumbered ? "back" : null);
  });
  return pos;
}

// 汇总：三级级联 → verdict + defaultInclude
export function classifyManuscriptFiles(
  files: ClassifierInput[],
  excludePaths: string[],
  projectFolder: string
): ClassifiedFile[] {
  const dominant = detectDominantNumberedPattern(files.map((f) => f.basename));
  const pos = frontBackPosition(files);
  const excluded = new Set(excludePaths.map((p) => p.replace(/\/+$/, "")));

  return files.map((f) => {
    const pattern = normalizePattern(f.basename);
    const isExcluded = [...excluded].some(
      (e) => f.path === e || f.path.startsWith(e + "/")
    );
    const p = pos.get(f.path) ?? null;
    if (isExcluded) return { ...f, pattern, verdict: "excluded", defaultInclude: false };
    if (f.number !== null && pattern === dominant) {
      return { ...f, pattern, verdict: "chapter", defaultInclude: true };
    }
    // 仅前置无编号（序/楔子，对应负编号位置锚定）默认纳入；后置无编号默认不纳入——
    // 插件端无法可靠区分「尾声」与「Story Bible/人物设定」等参考 note（见 spec 2.37.5），
    // 保守起见把后置交给预览确认 D。
    const defaultInclude = f.number !== null || p === "front";
    return { ...f, pattern, verdict: "needs-confirm", defaultInclude };
  });
}
