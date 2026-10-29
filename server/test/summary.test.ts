import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDatabase, type Db } from "../src/db.js";
import { llmRateLimited } from "../src/errors.js";
import { getLesson, updateSectionContent } from "../src/lessons/repository.js";
import { syncAllLessons } from "../src/lessons/sync.js";
import { FakeGateway, FakeLlm, sampleLessonBlocks, teacherJson } from "./fixtures.js";

let db: Db;
let llm: FakeLlm;
let app: ReturnType<typeof createApp>;
let lessonId: string;

beforeEach(async () => {
  db = openDatabase(":memory:");
  const notion = new FakeGateway();
  notion.addLesson("A2 基礎會話c 3/10", sampleLessonBlocks());
  lessonId = (await syncAllLessons(db, notion, "db-id")).lessons[0]!.id;
  const warmUp = getLesson(db, lessonId)!.sections.find((s) => s.title === "Warm-up")!;
  updateSectionContent(db, lessonId, warmUp.id, {
    prompts: ["How was your week?", "What did you do last weekend?"],
    vocabulary: [{ term: "busy", meaningZh: "忙碌" }],
    referenceAnswers: [],
  });
  llm = new FakeLlm();
  app = createApp({ db, notion: null, llm });
});

async function start() {
  llm.reply(teacherJson({ teacherReply: "Hi! How was your week?" }));
  return (await request(app).post("/api/sessions").send({ lessonId }).expect(201)).body.id as string;
}

const answer = (id: string, text: string, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/sessions/${id}/turns`)
    .send({ requestId: text, text, inputLanguage: "en-US", verifiedByStudent: true, ...extra })
    .expect(200);

/** A short lesson: one minor error, one Chinese-help detour, one plain answer. */
async function practise(id: string) {
  llm.reply(
    teacherJson({
      teacherReply: "I see. Why were you busy?",
      corrections: [{ type: "grammar", original: "I go to work", suggestion: "I went to work", reasonZh: "過去式", severity: "minor" }],
    }),
    teacherJson({
      teacherReply: "You can say: I stayed home. Can you try saying that?",
      intent: "chinese_assistance",
      nextAction: "repeat_or_skip",
      assistance: { english: "I stayed home.", zhExplanation: "stay home 待在家" },
    }),
    teacherJson({ teacherReply: "Great! What did you do last weekend?", nextAction: "advance" }),
  );
  await answer(id, "It was busy. I go to work every day.");
  await answer(id, "我待在家", { inputLanguage: "zh-TW" });
  await answer(id, "I stayed home and I watched the TV.");
}

const written = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    overviewZh: "你這次很努力地用英文分享了一週的生活。",
    naturalExpressions: [
      { original: "I watched the TV", better: "I watched TV", noteZh: "watch TV 不加 the" },
      { original: "I flew to Paris", better: "I went to Paris" }, // never said: dropped
      { original: "I go to work", better: "I went to work" }, // already a correction: dropped
      { original: "It was busy", better: "It was 很忙" }, // Chinese in the suggestion: dropped
    ],
    nextSteps: ["用過去式說說上週末做了什麼。"],
    ...o,
  });

describe("finishing a session", () => {
  it("writes the after-class summary from stored data plus the LLM's review (FR-11)", async () => {
    const id = await start();
    await practise(id);
    llm.reply(written());

    const res = await request(app).post(`/api/sessions/${id}/finish`).expect(200);

    expect(res.body).toMatchObject({ state: "finished", endedAt: expect.any(String) });
    expect(res.body.summary).toMatchObject({
      degraded: false,
      overviewZh: "你這次很努力地用英文分享了一週的生活。",
      sectionsCovered: [{ title: "Warm-up" }],
      stats: { answers: 3, chineseHelp: 1, corrections: 1 },
      corrections: [{ original: "I go to work", suggestion: "I went to work", reasonZh: "過去式" }],
      naturalExpressions: [{ original: "I watched the TV", better: "I watched TV", noteZh: "watch TV 不加 the" }],
      phrases: [{ english: "I stayed home.", zhExplanation: "stay home 待在家" }],
      vocabulary: [{ term: "busy", meaningZh: "忙碌" }],
      nextSteps: ["下次從「Warm-up」繼續這堂課。", "用過去式說說上週末做了什麼。"],
    });

    // The deferred correction was hidden during class; the summary is where it shows up.
    const during = res.body.turns.flatMap((t: { corrections?: unknown[] }) => t.corrections ?? []);
    expect(during).toEqual([]);

    const prompt = llm.requests.at(-1)!;
    expect(prompt.purpose).toBe("summary");
    expect(prompt.messages[1]!.content).toContain("I go to work -> I went to work");
    expect(prompt.messages[1]!.content).toContain("Student: I stayed home and I watched the TV.");
  });

  it("is idempotent and closes the session to new answers", async () => {
    const id = await start();
    await practise(id);
    llm.reply(written());
    const first = await request(app).post(`/api/sessions/${id}/finish`).expect(200);
    const calls = llm.requests.length;

    const again = await request(app).post(`/api/sessions/${id}/finish`).expect(200);
    expect(again.body.summary).toEqual(first.body.summary);
    expect(llm.requests).toHaveLength(calls);

    const late = await request(app)
      .post(`/api/sessions/${id}/turns`)
      .send({ requestId: "late", text: "Hello?", inputLanguage: "en-US", verifiedByStudent: true })
      .expect(409);
    expect(late.body.error.code).toBe("SESSION_NOT_ACTIVE");
    expect((await request(app).get(`/api/sessions/${id}`).expect(200)).body.summary.overviewZh).toBe(first.body.summary.overviewZh);
  });

  it("still gives a summary when the LLM is rate limited, and upgrades it later", async () => {
    const id = await start();
    await practise(id);
    llm.reply(llmRateLimited());

    const fallback = (await request(app).post(`/api/sessions/${id}/finish`).expect(200)).body.summary;
    expect(fallback).toMatchObject({
      degraded: true,
      overviewZh: "這次練習了「Warm-up」，回答了 3 次，老師提供了 1 次中文協助，有 1 個可以改進的地方。",
      corrections: [{ original: "I go to work" }],
      naturalExpressions: [],
    });
    expect(fallback.nextSteps[0]).toBe("下次從「Warm-up」繼續這堂課。");

    llm.reply(written());
    const upgraded = (await request(app).post(`/api/sessions/${id}/finish`).expect(200)).body.summary;
    expect(upgraded).toMatchObject({ degraded: false, overviewZh: "你這次很努力地用英文分享了一週的生活。" });

    // A failed retry keeps the good summary.
    expect((await request(app).post(`/api/sessions/${id}/finish`).expect(200)).body.summary.degraded).toBe(false);
  });

  it("never suggests a 'better' version of a sentence the student was repeating", async () => {
    const id = await start();
    llm.reply(
      teacherJson({
        teacherReply: "You can say: We watched a movie. Can you try saying that?",
        intent: "chinese_assistance",
        nextAction: "repeat_or_skip",
        assistance: { english: "We watched a movie." },
      }),
      teacherJson({ teacherReply: "Great! What movie?" }),
    );
    await answer(id, "我們看電影", { inputLanguage: "zh-TW" });
    await answer(id, "We watched a movie.");
    llm.reply(written({ naturalExpressions: [{ original: "We watched a movie", better: "We watched movies" }] }));

    const summary = (await request(app).post(`/api/sessions/${id}/finish`).expect(200)).body.summary;
    expect(summary.naturalExpressions).toEqual([]);
    expect(llm.requests.at(-1)!.messages[1]!.content).toContain(
      "Student (repeating the sentence the teacher offered, do not grade): We watched a movie.",
    );
  });

  it("does not grade unreviewed speech or the skip button, and skips the LLM with nothing to review", async () => {
    const id = await start();
    llm.reply(teacherJson(), teacherJson());
    await answer(id, "I go park", { verifiedByStudent: false });
    await answer(id, "Skip repeating, please. Let's go back to the question.");
    const calls = llm.requests.length;

    const summary = (await request(app).post(`/api/sessions/${id}/finish`).expect(200)).body.summary;
    expect(llm.requests).toHaveLength(calls);
    expect(summary).toMatchObject({ degraded: false, overviewZh: expect.stringContaining("還沒有完成回答"), naturalExpressions: [] });
  });

  it("works without an LLM configured", async () => {
    const id = await start();
    await practise(id);
    app = createApp({ db, notion: null, llm: null });
    const summary = (await request(app).post(`/api/sessions/${id}/finish`).expect(200)).body.summary;
    expect(summary).toMatchObject({ degraded: true, stats: { answers: 3 } });
  });
});

describe("history, deletion and export", () => {
  it("lists a lesson's sessions newest first for resuming and review (AT-12)", async () => {
    const older = await start();
    await practise(older);
    llm.reply(written());
    await request(app).post(`/api/sessions/${older}/finish`).expect(200);
    const newer = await start();

    const res = await request(app).get(`/api/sessions?lessonId=${lessonId}`).expect(200);
    expect(res.body.sessions.map((s: { id: string }) => s.id)).toEqual([newer, older]);
    expect(res.body.sessions[0]).toMatchObject({ state: "active", answers: 0, hasSummary: false, sectionTitle: "Warm-up" });
    expect(res.body.sessions[1]).toMatchObject({ state: "finished", answers: 3, hasSummary: true, lessonTitle: "A2 基礎會話c 3/10" });
    expect((await request(app).get("/api/sessions?lessonId=other").expect(200)).body.sessions).toEqual([]);
  });

  it("exports everything stored, including deferred feedback (NFR-05)", async () => {
    const id = await start();
    await practise(id);
    const res = await request(app).get("/api/export").expect(200);
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="?ai-english-tutor-\d{4}-\d{2}-\d{2}\.json"?$/);
    expect(res.body.settings.studentLevel).toBe("A2");
    expect(res.body.sessions[0]).toMatchObject({ id, feedback: [{ original: "I go to work", deferred: true }] });
    expect(JSON.stringify(res.body)).not.toContain("sourceMarkdown");
  });

  it("deletes one session or, with confirmation, all of them", async () => {
    const a = await start();
    await practise(a);
    const b = await start();

    await request(app).delete(`/api/sessions/${a}`).expect(204);
    await request(app).get(`/api/sessions/${a}`).expect(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM turns WHERE session_id = ?").get(a)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM feedback").get()).toEqual({ n: 0 });
    await request(app).delete(`/api/sessions/${a}`).expect(404);

    expect((await request(app).delete("/api/sessions").expect(400)).body.error.code).toBe("CONFIRM_REQUIRED");
    expect((await request(app).delete("/api/sessions?confirm=all").expect(200)).body).toEqual({ deleted: 1 });
    await request(app).get(`/api/sessions/${b}`).expect(404);
  });
});
