import express, { type ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import type { Db } from "./db.js";
import { AppError, notionNotConfigured } from "./errors.js";
import { getLesson, getSection, isKnownResourceBlock, listLessons, updateSectionContent } from "./lessons/repository.js";
import { syncAllLessons, syncLesson } from "./lessons/sync.js";
import { sectionContentSchema } from "./lessons/types.js";
import { toStudentLesson, toStudentLessonSummary } from "./lessons/views.js";
import type { NotionGateway } from "./notion/gateway.js";

export interface AppDeps {
  db: Db;
  /** Null when NOTION_TOKEN or NOTION_LESSONS_DATABASE_ID is missing; synced lessons stay usable. */
  notion: { gateway: NotionGateway; databaseId: string } | null;
}

export function createApp({ db, notion }: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  const requireNotion = () => {
    if (!notion) throw notionNotConfigured();
    return notion;
  };

  app.get("/api/notion/status", async (_req, res) => {
    if (!notion) {
      res.json({ configured: false, ok: false, error: toBody(notionNotConfigured()).error });
      return;
    }
    try {
      const databaseTitle = await notion.gateway.getDatabaseTitle(notion.databaseId);
      res.json({ configured: true, ok: true, databaseTitle });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      res.json({ configured: true, ok: false, error: toBody(err).error });
    }
  });

  app.post("/api/lessons/sync", async (_req, res) => {
    const { gateway, databaseId } = requireNotion();
    res.json(await syncAllLessons(db, gateway, databaseId));
  });

  app.post("/api/lessons/:id/sync", async (req, res) => {
    res.json(await syncLesson(db, requireNotion().gateway, req.params.id));
  });

  app.get("/api/lessons", (_req, res) => {
    res.json({ lessons: listLessons(db).map(toStudentLessonSummary) });
  });

  app.get("/api/lessons/:id", (req, res) => {
    const lesson = getLesson(db, req.params.id);
    if (!lesson) throw lessonNotFound();
    res.json(toStudentLesson(lesson));
  });

  // Lesson-editing view (FR-02): deliberately includes the answer key and Notion source.
  app.get("/api/lessons/:id/sections/:sectionId", (req, res) => {
    const section = getSection(db, req.params.id, req.params.sectionId);
    if (!section) throw sectionNotFound();
    res.json(section);
  });

  app.put("/api/lessons/:id/sections/:sectionId", (req, res) => {
    const content = sectionContentSchema.parse(req.body);
    const section = updateSectionContent(db, req.params.id, req.params.sectionId, content);
    if (!section) throw sectionNotFound();
    res.json(section);
  });

  // Notion-hosted file URLs expire, so files are resolved on demand.
  app.get("/api/resources/:blockId", async (req, res) => {
    if (!isKnownResourceBlock(db, req.params.blockId)) {
      throw new AppError(404, "RESOURCE_NOT_FOUND", "找不到這個教材檔案。");
    }
    const url = await requireNotion().gateway.getFileUrl(req.params.blockId);
    if (!url) throw new AppError(404, "RESOURCE_NOT_FOUND", "Notion 上已找不到這個教材檔案，請重新同步。");
    res.redirect(302, url);
  });

  app.use("/api", (_req, _res, next) => next(new AppError(404, "NOT_FOUND", "找不到這個 API。")));
  app.use(errorHandler);
  return app;
}

const lessonNotFound = () => new AppError(404, "LESSON_NOT_FOUND", "找不到這堂課。");
const sectionNotFound = () => new AppError(404, "SECTION_NOT_FOUND", "找不到這個章節。");

const toBody = (err: AppError) => ({ error: { code: err.code, message: err.message } });

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json(toBody(err));
  } else if (err instanceof ZodError) {
    res.status(400).json({ error: { code: "INVALID_REQUEST", message: "資料格式不正確。", issues: err.issues } });
  } else if (err?.type === "entity.parse.failed" || err?.type === "entity.too.large") {
    res.status(err.status ?? 400).json({ error: { code: "INVALID_REQUEST", message: "請求內容無法解析或過大。" } });
  } else {
    // Log only the error, never request bodies (they may contain private transcripts).
    console.error(err);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "伺服器發生錯誤。" } });
  }
};
