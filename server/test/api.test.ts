import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDatabase, type Db } from "../src/db.js";
import { getLesson, updateSectionContent } from "../src/lessons/repository.js";
import { FakeGateway, sampleLessonBlocks } from "./fixtures.js";

let db: Db;
let notion: FakeGateway;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDatabase(":memory:");
  notion = new FakeGateway();
  notion.addLesson("A2 基礎會話c 3/10", sampleLessonBlocks());
  app = createApp({ db, notion: { gateway: notion, databaseId: "db-id" } });
});

async function syncedLessonId() {
  const res = await request(app).post("/api/lessons/sync").expect(200);
  return res.body.lessons[0].id as string;
}

describe("lesson API", () => {
  it("syncs and lists lessons", async () => {
    const id = await syncedLessonId();
    const res = await request(app).get("/api/lessons").expect(200);
    expect(res.body.lessons).toEqual([expect.objectContaining({ id, title: "A2 基礎會話c 3/10", series: "c", unit: 3 })]);
  });

  it("never exposes the Notion source or answer key in the student view", async () => {
    const id = await syncedLessonId();
    const section = getLesson(db, id)!.sections.find((s) => s.title === "Vocabulary")!;
    updateSectionContent(db, id, section.id, {
      prompts: ["A bag for clothes."],
      vocabulary: [{ term: "suitcase", meaningZh: "行李箱" }],
      referenceAnswers: [{ prompt: "A bag for clothes.", answer: "suitcase-ANSWER" }],
    });

    const res = await request(app).get(`/api/lessons/${id}`).expect(200);
    const body = JSON.stringify(res.body);

    expect(body).not.toContain("sourceMarkdown");
    expect(body).not.toContain("referenceAnswers");
    expect(body).not.toContain("suitcase-ANSWER");
    expect(body).not.toContain("答案");
    const vocab = res.body.sections.find((s: { title: string }) => s.title === "Vocabulary");
    expect(vocab).toEqual({
      id: section.id,
      kind: "vocabulary",
      title: "Vocabulary",
      prompts: ["A bag for clothes."],
      vocabulary: [{ term: "suitcase", meaningZh: "行李箱" }],
      resources: [],
    });
  });

  it("serves hosted files through the resource route instead of storing their URL", async () => {
    const id = await syncedLessonId();
    const res = await request(app).get(`/api/lessons/${id}`).expect(200);
    const url = res.body.sections[0].resources[0].url as string;
    expect(url).toMatch(/^\/api\/resources\//);

    const redirect = await request(app).get(url).expect(302);
    expect(redirect.headers.location).toMatch(/^https:\/\/files\.example\.com\//);
    await request(app).get("/api/resources/not-a-known-block").expect(404);
  });

  it("validates and saves section corrections", async () => {
    const id = await syncedLessonId();
    const sectionId = getLesson(db, id)!.sections[1]!.id;
    const url = `/api/lessons/${id}/sections/${sectionId}`;

    const bad = await request(app).put(url).send({ prompts: [""] }).expect(400);
    expect(bad.body.error.code).toBe("INVALID_REQUEST");

    const ok = await request(app)
      .put(url)
      .send({ prompts: ["How was your week?"], vocabulary: [], referenceAnswers: [] })
      .expect(200);
    expect(ok.body).toMatchObject({ editedByUser: true, extractionStatus: "done", prompts: ["How was your week?"] });

    const full = await request(app).get(url).expect(200);
    expect(full.body.sourceMarkdown).toBe("Tell me about your week.");
  });

  it("returns 404s with error codes", async () => {
    expect((await request(app).get("/api/lessons/missing").expect(404)).body.error.code).toBe("LESSON_NOT_FOUND");
    expect((await request(app).get("/api/nope").expect(404)).body.error.code).toBe("NOT_FOUND");
  });
});

describe("without Notion configured", () => {
  beforeEach(() => {
    app = createApp({ db, notion: null });
  });

  it("reports status and refuses to sync, but still serves synced lessons", async () => {
    const status = await request(app).get("/api/notion/status").expect(200);
    expect(status.body).toMatchObject({ configured: false, ok: false, error: { code: "NOTION_NOT_CONFIGURED" } });

    const sync = await request(app).post("/api/lessons/sync").expect(503);
    expect(sync.body.error.code).toBe("NOTION_NOT_CONFIGURED");

    await request(app).get("/api/lessons").expect(200);
  });
});
