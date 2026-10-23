import type { Db } from "../db.js";
import { AppError } from "../errors.js";
import type { NotionGateway, LessonRow } from "../notion/gateway.js";
import {
  findLessonByNotionPageId,
  getLesson,
  markLessonStale,
  markMissingLessonsStale,
  saveLessonSnapshot,
} from "./repository.js";
import { buildSections } from "./sections.js";
import { parseLessonTitle } from "./title.js";
import type { SyncWarning } from "./types.js";

export type LessonSyncStatus = "created" | "updated" | "unchanged" | "stale";

export interface SyncResult {
  lessons: { id: string; title: string; status: LessonSyncStatus }[];
  warnings: SyncWarning[];
}

let running = false;

async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (running) throw new AppError(409, "SYNC_IN_PROGRESS", "正在同步中，請等目前的同步完成。");
  running = true;
  try {
    return await fn();
  } finally {
    running = false;
  }
}

/**
 * One-way sync of every lesson row in the Notion lessons database into SQLite.
 * Only rows whose last_edited_time changed are re-read block by block.
 */
export function syncAllLessons(db: Db, gateway: NotionGateway, databaseId: string, now = () => new Date()): Promise<SyncResult> {
  return exclusive(async () => {
    const result: SyncResult = { lessons: [], warnings: [] };
    const rows = (await gateway.listLessonRows(databaseId)).filter((r) => !r.archived);
    const seen = new Set<string>();
    for (const row of rows) {
      const parsed = parseLessonTitle(row.title);
      if (!parsed) {
        result.warnings.push({ message: `略過「${row.title.trim() || "（無標題）"}」：標題不符合課程命名規則（例如「A2 基礎會話c 3/10」）。` });
        continue;
      }
      seen.add(row.pageId);
      const existing = findLessonByNotionPageId(db, row.pageId);
      if (existing && !existing.stale && existing.notionLastEditedAt === row.lastEditedTime) {
        result.lessons.push({ id: existing.id, title: existing.title, status: "unchanged" });
        continue;
      }
      result.lessons.push(await syncRow(db, gateway, row, result.warnings, now));
    }
    for (const lesson of markMissingLessonsStale(db, seen)) {
      result.lessons.push({ id: lesson.id, title: lesson.title, status: "stale" });
      result.warnings.push({ lessonTitle: lesson.title, message: "這堂課已不在 Notion 資料庫中，標示為失效。" });
    }
    return result;
  });
}

/** Re-reads one lesson from Notion regardless of its last_edited_time. */
export function syncLesson(db: Db, gateway: NotionGateway, lessonId: string, now = () => new Date()): Promise<SyncResult> {
  return exclusive(async () => {
    const lesson = getLesson(db, lessonId);
    if (!lesson) throw new AppError(404, "LESSON_NOT_FOUND", "找不到這堂課。");
    if (!lesson.notionPageId) throw new AppError(400, "NOT_A_NOTION_LESSON", "這堂課不是從 Notion 同步的。");
    const result: SyncResult = { lessons: [], warnings: [] };
    const row = await gateway.getLessonRow(lesson.notionPageId);
    if (row.archived || !parseLessonTitle(row.title)) {
      markLessonStale(db, lesson.id);
      result.lessons.push({ id: lesson.id, title: lesson.title, status: "stale" });
      result.warnings.push({ lessonTitle: lesson.title, message: "這堂課已在 Notion 刪除或改名為非課程標題，標示為失效。" });
      return result;
    }
    result.lessons.push(await syncRow(db, gateway, row, result.warnings, now));
    return result;
  });
}

async function syncRow(
  db: Db,
  gateway: NotionGateway,
  row: LessonRow,
  warnings: SyncWarning[],
  now: () => Date,
): Promise<SyncResult["lessons"][number]> {
  const parsed = parseLessonTitle(row.title)!;
  const blocks = await gateway.getBlockTree(row.pageId);
  const built = buildSections(row.pageId, blocks);
  warnings.push(...built.warnings.map((message) => ({ lessonTitle: parsed.title, message })));
  const { id, created } = saveLessonSnapshot(db, {
    notionPageId: row.pageId,
    notionLastEditedAt: row.lastEditedTime,
    parsed,
    sections: built.sections,
    syncedAt: now().toISOString(),
  });
  return { id, title: parsed.title, status: created ? "created" : "updated" };
}
