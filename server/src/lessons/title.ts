export interface ParsedTitle {
  title: string;
  level: string;
  course: string;
  series: string | null;
  unit: number;
  totalUnits: number;
}

const TITLE_RE = /^([ABC][12])\s*(.+?)\s*(\d+)\s*\/\s*(\d+)$/i;
// A trailing single-letter series either follows whitespace ("Business English c")
// or sits directly after a non-ASCII character ("基礎會話c").
const SERIES_RE = /^(.*?)(?:\s+|(?<=[^\x00-\x7F]))([a-z])$/i;

/** Parses lesson titles like "A2 基礎會話c 3/10"; returns null for rows that are not lessons (e.g. "Template"). */
export function parseLessonTitle(raw: string): ParsedTitle | null {
  const title = raw.replace(/\s+/g, " ").trim();
  const m = TITLE_RE.exec(title);
  if (!m) return null;
  const [, level, rest, unit, total] = m as unknown as [string, string, string, string, string];
  const unitNo = Number(unit);
  const totalUnits = Number(total);
  if (unitNo < 1 || unitNo > totalUnits) return null;

  const s = SERIES_RE.exec(rest);
  const course = (s ? s[1]! : rest).trim();
  if (!course) return null;
  return {
    title,
    level: level.toUpperCase(),
    course,
    series: s ? s[2]!.toLowerCase() : null,
    unit: unitNo,
    totalUnits,
  };
}
