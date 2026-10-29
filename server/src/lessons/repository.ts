import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { BuiltSection } from "./sections.js";
import type { ParsedTitle } from "./title.js";
import type { Lesson, LessonSummary, Section, SectionContent, SectionKind, ExtractionStatus } from "./types.js";

interface LessonRowDb {
  id: string;
  notion_page_id: string | null;
  title: string;
  level: string | null;
  course: string | null;
  series: string | null;
  unit: number | null;
  total_units: number | null;
  topic: string | null;
  notion_last_edited_at: string | null;
  last_synced_at: string;
  stale: number;
}

interface SectionRowDb {
  id: string;
  lesson_id: string;
  notion_block_id: string | null;
  position: number;
  kind: string;
  title: string;
  source_markdown: string;
  source_hash: string;
  prompts: string;
  vocabulary: string;
  reference_answers: string;
  resources: string;
  extraction_status: string;
  edited_by_user: number;
  stale: number;
}

const toLessonSummary = (r: LessonRowDb): LessonSummary => ({
  id: r.id,
  notionPageId: r.notion_page_id,
  title: r.title,
  level: r.level,
  course: r.course,
  series: r.series,
  unit: r.unit,
  totalUnits: r.total_units,
  topic: r.topic,
  notionLastEditedAt: r.notion_last_edited_at,
  lastSyncedAt: r.last_synced_at,
  stale: r.stale === 1,
});

const toSection = (r: SectionRowDb): Section => ({
  id: r.id,
  lessonId: r.lesson_id,
  notionBlockId: r.notion_block_id,
  position: r.position,
  kind: r.kind as SectionKind,
  title: r.title,
  sourceMarkdown: r.source_markdown,
  sourceHash: r.source_hash,
  prompts: JSON.parse(r.prompts),
  vocabulary: JSON.parse(r.vocabulary),
  referenceAnswers: JSON.parse(r.reference_answers),
  resources: JSON.parse(r.resources),
  extractionStatus: r.extraction_status as ExtractionStatus,
  editedByUser: r.edited_by_user === 1,
  stale: r.stale === 1,
});

export function listLessons(db: Db): LessonSummary[] {
  const rows = db
    .prepare(
      `SELECT * FROM lessons
       ORDER BY stale, level, course, series, unit, title`,
    )
    .all() as LessonRowDb[];
  return rows.map(toLessonSummary);
}

export function getLesson(db: Db, id: string): Lesson | null {
  const row = db.prepare("SELECT * FROM lessons WHERE id = ?").get(id) as LessonRowDb | undefined;
  if (!row) return null;
  const sections = db
    .prepare("SELECT * FROM sections WHERE lesson_id = ? ORDER BY stale, position")
    .all(id) as SectionRowDb[];
  return { ...toLessonSummary(row), sections: sections.map(toSection) };
}

export function findLessonByNotionPageId(db: Db, pageId: string): LessonSummary | null {
  const row = db.prepare("SELECT * FROM lessons WHERE notion_page_id = ?").get(pageId) as LessonRowDb | undefined;
  return row ? toLessonSummary(row) : null;
}

export function getSection(db: Db, lessonId: string, sectionId: string): Section | null {
  const row = db.prepare("SELECT * FROM sections WHERE id = ? AND lesson_id = ?").get(sectionId, lessonId) as
    | SectionRowDb
    | undefined;
  return row ? toSection(row) : null;
}

export interface SnapshotInput {
  notionPageId: string;
  notionLastEditedAt: string;
  parsed: ParsedTitle;
  sections: BuiltSection[];
  syncedAt: string;
}

/**
 * Writes a fresh Notion snapshot for one lesson, keyed by Notion ids so that ids,
 * session progress and manual corrections survive re-syncs. A section whose source
 * changed goes back to `pending` extraction, or to `needs_review` if the user had
 * corrected it. Sections missing from Notion are marked stale, not deleted.
 */
export function saveLessonSnapshot(db: Db, input: SnapshotInput): { id: string; created: boolean } {
  return db.transaction(() => {
    const existing = findLessonByNotionPageId(db, input.notionPageId);
    const id = existing?.id ?? randomUUID();
    const p = input.parsed;
    db.prepare(
      `INSERT INTO lessons (id, notion_page_id, title, level, course, series, unit, total_units,
                            notion_last_edited_at, last_synced_at, stale)
       VALUES (@id, @notionPageId, @title, @level, @course, @series, @unit, @totalUnits,
               @notionLastEditedAt, @syncedAt, 0)
       ON CONFLICT (id) DO UPDATE SET
         title = excluded.title, level = excluded.level, course = excluded.course,
         series = excluded.series, unit = excluded.unit, total_units = excluded.total_units,
         notion_last_edited_at = excluded.notion_last_edited_at,
         last_synced_at = excluded.last_synced_at, stale = 0`,
    ).run({
      id,
      notionPageId: input.notionPageId,
      title: p.title,
      level: p.level,
      course: p.course,
      series: p.series,
      unit: p.unit,
      totalUnits: p.totalUnits,
      notionLastEditedAt: input.notionLastEditedAt,
      syncedAt: input.syncedAt,
    });

    const current = new Map(
      (
        db.prepare("SELECT * FROM sections WHERE lesson_id = ?").all(id) as SectionRowDb[]
      ).map((r) => [r.notion_block_id, r]),
    );
    const insert = db.prepare(
      `INSERT INTO sections (id, lesson_id, notion_block_id, position, kind, title, source_markdown,
                             source_hash, resources)
       VALUES (@id, @lessonId, @notionBlockId, @position, @kind, @title, @sourceMarkdown, @sourceHash, @resources)`,
    );
    const update = db.prepare(
      `UPDATE sections SET position = @position, kind = @kind, title = @title,
         source_markdown = @sourceMarkdown, source_hash = @sourceHash, resources = @resources,
         extraction_status = @extractionStatus, stale = 0
       WHERE id = @id`,
    );
    for (const s of input.sections) {
      const row = current.get(s.notionBlockId);
      current.delete(s.notionBlockId);
      const values = { ...s, lessonId: id, resources: JSON.stringify(s.resources) };
      if (!row) {
        insert.run({ ...values, id: randomUUID() });
        continue;
      }
      const changed = row.source_hash !== s.sourceHash;
      const extractionStatus = !changed ? row.extraction_status : row.edited_by_user ? "needs_review" : "pending";
      update.run({ ...values, id: row.id, extractionStatus });
    }
    const markStale = db.prepare("UPDATE sections SET stale = 1 WHERE id = ?");
    for (const row of current.values()) markStale.run(row.id);

    return { id, created: !existing };
  })();
}

/** Marks every Notion-backed lesson not in `keepPageIds` as stale; returns the affected lessons. */
export function markMissingLessonsStale(db: Db, keepPageIds: Set<string>): LessonSummary[] {
  const rows = db
    .prepare("SELECT * FROM lessons WHERE notion_page_id IS NOT NULL AND stale = 0")
    .all() as LessonRowDb[];
  const missing = rows.filter((r) => !keepPageIds.has(r.notion_page_id!));
  const mark = db.prepare("UPDATE lessons SET stale = 1 WHERE id = ?");
  db.transaction(() => missing.forEach((r) => mark.run(r.id)))();
  return missing.map((r) => toLessonSummary({ ...r, stale: 1 }));
}

export function markLessonStale(db: Db, id: string): void {
  db.prepare("UPDATE lessons SET stale = 1 WHERE id = ?").run(id);
}

/** Stores a manual correction (FR-02); it is never silently overwritten by later syncs. */
export function updateSectionContent(db: Db, lessonId: string, sectionId: string, content: SectionContent): Section | null {
  const result = db
    .prepare(
      `UPDATE sections SET prompts = ?, vocabulary = ?, reference_answers = ?,
         edited_by_user = 1, extraction_status = 'done'
       WHERE id = ? AND lesson_id = ?`,
    )
    .run(
      JSON.stringify(content.prompts),
      JSON.stringify(content.vocabulary),
      JSON.stringify(content.referenceAnswers),
      sectionId,
      lessonId,
    );
  return result.changes ? getSection(db, lessonId, sectionId) : null;
}

/**
 * Stores an LLM extraction result (or its failure) for the section source it was made from.
 * Does nothing if the section was re-synced with a different source meanwhile.
 */
export function saveExtraction(db: Db, sectionId: string, sourceHash: string, content: SectionContent | null): boolean {
  const result = content
    ? db
        .prepare(
          `UPDATE sections SET prompts = ?, vocabulary = ?, reference_answers = ?,
             edited_by_user = 0, extraction_status = 'done'
           WHERE id = ? AND source_hash = ?`,
        )
        .run(
          JSON.stringify(content.prompts),
          JSON.stringify(content.vocabulary),
          JSON.stringify(content.referenceAnswers),
          sectionId,
          sourceHash,
        )
    : db
        .prepare("UPDATE sections SET extraction_status = 'failed' WHERE id = ? AND source_hash = ?")
        .run(sectionId, sourceHash);
  return result.changes > 0;
}

/** Keeps the user's correction for a section whose Notion source changed (`needs_review` → `done`). */
export function keepSectionCorrection(db: Db, lessonId: string, sectionId: string): Section | null {
  const result = db
    .prepare(
      `UPDATE sections SET extraction_status = 'done'
       WHERE id = ? AND lesson_id = ? AND extraction_status = 'needs_review'`,
    )
    .run(sectionId, lessonId);
  return result.changes ? getSection(db, lessonId, sectionId) : null;
}

/** True if `blockId` is a file resource of some synced section, so the app only proxies its own files. */
export function isKnownResourceBlock(db: Db, blockId: string): boolean {
  const rows = db
    .prepare("SELECT resources FROM sections WHERE instr(resources, ?) > 0")
    .all(blockId) as { resources: string }[];
  return rows.some((r) => (JSON.parse(r.resources) as { blockId: string }[]).some((res) => res.blockId === blockId));
}
