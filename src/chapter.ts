/**
 * Chapter-number helpers shared across the plugin (main.ts + board.ts).
 * Extracted to avoid a board.ts ↔ main.ts circular import: both need to map a
 * note filename to its chapter number for "chapter_number → note file" lookups.
 */

const CN_DIGITS: Record<string, number> = {
  "零": 0, "〇": 0,
  "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
  "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
};

const CN_UNITS: Record<string, number> = {
  "十": 10, "百": 100, "千": 1000, "万": 10000,
};

function chineseToNumber(text: string): number | null {
  let total = 0;
  let section = 0;
  let number = 0;
  for (const ch of text) {
    if (ch in CN_DIGITS) {
      number = CN_DIGITS[ch];
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      if (unit === 10000) {
        section = (section + number) * unit;
        total += section;
        section = 0;
      } else {
        section += (number === 0 ? 1 : number) * unit;
      }
      number = 0;
    } else {
      return null;
    }
  }
  return total + section + number;
}

export function extractChapterNumber(filename: string): number | null {
  // 1. 中文「第N章/回/节/卷/部」优先
  const chinese = filename.match(/第([零〇一二两三四五六七八九十百千万]+)[章回节卷部]/);
  if (chinese) {
    const value = chineseToNumber(chinese[1]);
    if (value !== null) return value;
  }

  // 2. 英文「Chapter N / Ch.N」次优先（避免把标题里的数字误当章节号）
  const english = filename.match(/chapter\s*(\d+)/i);
  if (english) return parseInt(english[1], 10);

  // 3. 阿拉伯数字兜底：先剥掉日期前缀（如 2026-09-28），再取第一个独立数字。
  //    修复：/\d+/ 会误抓日期年份（"2026-09-28 第5章" → 抓到 2026）。
  const stripped = filename.replace(/^\d{4}[-_./]\d{1,2}[-_./]\d{1,2}[-_./]?/, "");
  const arabic = stripped.match(/\d+/);
  if (arabic) return parseInt(arabic[0], 10);

  return null;
}
