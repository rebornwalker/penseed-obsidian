/**
 * Plugin-side chapter numbering (Phase 0.37, simplified port of the web-side
 * `assignChapterNumbers` in frontend-react/src/utils/chapterSplitter.ts).
 *
 * The plugin treats "file == chapter", so there is no content order to anchor
 * against. Unnumbered files are sorted by basename and placed BEFORE all
 * numbered files, then assigned negative numbers -K..-1 via position anchoring.
 * "Unnumbered AFTER the last numbered file → max+1" is intentionally NOT done:
 * the plugin cannot reliably tell front-matter from back-matter (see spec 2.37.5).
 */

export interface PluginChapterItem {
  basename: string;
  number: number | null;
}

export function assignPluginChapterNumbers(
  items: PluginChapterItem[]
): { number: number | null; warning: string | null }[] {
  const hasNumbered = items.some((i) => i.number !== null);
  if (!hasNumbered) {
    // 全书无编号 → 顺序 1..N（保留 web 端行为）
    return items.map((_, i) => ({ number: i + 1, warning: null }));
  }

  // 无编号文件按 basename 排序，逆序分配负编号 -k..-1（序/楔子等前置章）。
  // 返回保持输入顺序，确保调用方 assigned[i] 与输入 items[i] 一一对应。
  const unnumberedSorted = items
    .filter((i) => i.number === null)
    .sort((a, b) => a.basename.localeCompare(b.basename));
  const k = unnumberedSorted.length;
  const negByBasename = new Map<string, number>();
  unnumberedSorted.forEach((u, i) => negByBasename.set(u.basename, -(k - i)));

  return items.map((item) => {
    if (item.number !== null) return { number: item.number, warning: null };
    return { number: negByBasename.get(item.basename) ?? null, warning: null };
  });
}
