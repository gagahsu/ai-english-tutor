import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDatabase, type Db } from "../src/db.js";
import { llmRateLimited } from "../src/errors.js";
import { getLesson, updateSectionContent } from "../src/lessons/repository.js";
import { syncAllLessons } from "../src/lessons/sync.js";
import { listFeedback } from "../src/sessions/repository.js";
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
    prompts: ["How was your week?", "What did you do on Sunday?"],
    vocabulary: [],
    referenceAnswers: [{ prompt: "How was your week?", answer: "SECRET-MODEL-ANSWER" }],
  });
  llm = new FakeLlm();
  app = createApp({ db, notion: null, llm });
});

async function start() {
  llm.reply(teacherJson({ teacherReply: "Hi! How was your week?" }));
  const res = await request(app).post("/api/sessions").send({ lessonId }).expect(201);
  return res.body as { id: string; sectionTitle: string; turns: { role: string; text: string }[] };
}

const answer = (id: string, text: string, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/sessions/${id}/turns`)
    .send({ requestId: text, text, inputLanguage: "en-US", verifiedByStudent: true, ...extra });

describe("sessions", () => {
  it("opens with the teacher asking the first Warm-up question", async () => {
    const session = await start();
    expect(session).toMatchObject({ state: "active", sectionTitle: "Warm-up", questionIndex: 0, lessonTitle: "A2 基礎會話c 3/10" });
    expect(session.turns).toEqual([expect.objectContaining({ role: "teacher", text: "Hi! How was your week?", degraded: false })]);

    const prompt = llm.requests[0]!.messages[0]!.content;
    expect(prompt).toContain('Current question: "How was your week?"');
    expect(prompt).toContain("SECRET-MODEL-ANSWER"); // the teacher sees the key...
    const view = await request(app).get(`/api/sessions/${session.id}`).expect(200);
    expect(JSON.stringify(view.body)).not.toContain("SECRET-MODEL-ANSWER"); // ...the student never does
  });

  it("makes sure the opening asks the first question", async () => {
    llm.reply(teacherJson({ teacherReply: "Hello! How are you today?" }));
    const res = await request(app).post("/api/sessions").send({ lessonId }).expect(201);
    expect(res.body.turns[0].text).toBe("Hello! How was your week?");
  });

  it("still opens the lesson with a fixed line when the LLM is unavailable", async () => {
    llm.reply(llmRateLimited());
    const res = await request(app).post("/api/sessions").send({ lessonId }).expect(201);
    expect(res.body.turns[0]).toMatchObject({ text: "Hi! Let's start with Warm-up. How was your week?", degraded: true });
  });

  it("answers a turn, advances on the controller's terms and stores the exchange", async () => {
    const { id } = await start();
    llm.reply(teacherJson({ teacherReply: "Great! What did you do on Sunday?", nextAction: "advance" }));

    const res = await answer(id, "It was good.").expect(200);

    expect(res.body.teacher).toMatchObject({ role: "teacher", text: "Great! What did you do on Sunday?", nextAction: "advance" });
    expect(res.body.student).toMatchObject({ role: "student", text: "It was good.", verifiedByStudent: true, corrections: [] });
    expect(res.body.session).toMatchObject({ state: "active", sectionTitle: "Warm-up", questionIndex: 1 });

    const sent = llm.requests[1]!.messages;
    expect(sent.at(-1)).toEqual({
      role: "user",
      content: JSON.stringify({ studentSaid: "It was good.", inputMode: "en-US", containsChinese: false, reviewedByStudent: true }),
    });
    expect(sent.at(-2)).toEqual({ role: "assistant", content: "Hi! How was your week?" });
  });

  it("returns the stored reply for a repeated requestId without calling the LLM again", async () => {
    const { id } = await start();
    llm.reply(teacherJson());
    const first = await answer(id, "It was good.").expect(200);
    const again = await answer(id, "It was good.").expect(200);

    expect(again.body.teacher.id).toBe(first.body.teacher.id);
    expect(llm.requests).toHaveLength(2);
    expect((await request(app).get(`/api/sessions/${id}`)).body.turns).toHaveLength(3);
  });

  it("keeps the answer unsaved on an LLM error so it can be resent (AT-10)", async () => {
    const { id } = await start();
    llm.reply(llmRateLimited());
    const failed = await answer(id, "It was good.").expect(429);
    expect(failed.body.error.code).toBe("LLM_RATE_LIMIT");
    expect((await request(app).get(`/api/sessions/${id}`)).body).toMatchObject({ questionIndex: 0, turns: [expect.anything()] });

    llm.reply(teacherJson());
    await answer(id, "It was good.").expect(200);
  });

  it("retries invalid output once, then degrades without moving the lesson", async () => {
    const { id } = await start();
    llm.reply("not json", '{"intent": "answer"}');

    const res = await answer(id, "It was good.").expect(200);

    expect(res.body.teacher).toMatchObject({ degraded: true, text: "Sorry, I didn't catch that. How was your week?" });
    expect(res.body.session.questionIndex).toBe(0);
    const retry = llm.requests[2]!.messages;
    expect(retry.at(-2)).toEqual({ role: "assistant", content: "not json" });
    expect(retry.at(-1)!.content).toContain("not valid for the required JSON format");
  });

  it("shows one blocking correction now and keeps minor ones for the summary", async () => {
    const { id } = await start();
    llm.reply(
      teacherJson({
        nextAction: "correct",
        corrections: [
          { type: "grammar", original: "I go park", suggestion: "I went to the park", reasonZh: "過去式", severity: "blocking" },
          { type: "grammar", original: "it were fun", suggestion: "it was fun", severity: "minor" },
        ],
      }),
    );
    const res = await answer(id, "I go park, it were fun.").expect(200);

    expect(res.body.student.corrections).toEqual([
      { type: "grammar", original: "I go park", suggestion: "I went to the park", reasonZh: "過去式" },
    ]);
    expect(listFeedback(db, id).map((f) => [f.original, f.deferred])).toEqual([
      ["I go park", false],
      ["it were fun", true],
    ]);
  });

  it("records a correction the model repeats in a later turn only once", async () => {
    const { id } = await start();
    const same = { type: "grammar", original: "we very tired", suggestion: "we were very tired", severity: "minor" };
    llm.reply(teacherJson({ corrections: [same] }), teacherJson({ corrections: [same] }));
    await answer(id, "We very tired.").expect(200);
    await answer(id, "Yes.").expect(200);
    expect(listFeedback(db, id)).toHaveLength(1);
  });

  it("does not grade an unverified transcript", async () => {
    const { id } = await start();
    llm.reply(teacherJson({ corrections: [{ type: "grammar", original: "a", suggestion: "b", severity: "blocking" }] }));
    await answer(id, "I go park.", { verifiedByStudent: false }).expect(200);
    expect(listFeedback(db, id)).toEqual([]);
  });

  it("records Chinese help and keeps the question", async () => {
    const { id } = await start();
    llm.reply(
      teacherJson({
        teacherReply: "You can say: I stayed home. Can you try saying that?",
        intent: "chinese_assistance",
        nextAction: "repeat_or_skip",
        assistance: { english: "I stayed home.", zhExplanation: "stay home 待在家" },
      }),
    );
    const res = await answer(id, "我待在家", { inputLanguage: "zh-TW" }).expect(200);
    expect(res.body.teacher).toMatchObject({
      intent: "chinese_assistance",
      nextAction: "repeat_or_skip",
      assistance: { english: "I stayed home.", zhExplanation: "stay home 待在家" },
    });
    expect(res.body.session.questionIndex).toBe(0);

    expect(llm.requests.at(-1)!.messages.at(-1)!.content).toContain('"containsChinese":true');
    expect(llm.requests.at(-1)!.messages[0]!.content).toContain("latest message contains Chinese");

    llm.reply(teacherJson({ teacherReply: "**Great** job! What did you _do_ at home?" }));
    const next = await answer(id, "I stayed home.").expect(200);
    expect(llm.requests.at(-1)!.messages[0]!.content).toContain('offered the phrase "I stayed home."');
    expect(next.body.teacher.text).toBe("Great job! What did you do at home?");
  });

  it("re-asks once when the model grades a mixed Chinese answer as plain English (AT-05)", async () => {
    const { id } = await start();
    llm.reply(
      teacherJson({ teacherReply: "Nice! Next question.", nextAction: "advance" }),
      teacherJson({
        teacherReply: "You can say: I ate beef noodles. Can you try saying that?",
        intent: "chinese_assistance",
        nextAction: "repeat_or_skip",
        assistance: { english: "I ate beef noodles." },
      }),
    );
    const res = await answer(id, "I eat 牛肉麵 很好吃").expect(200);

    expect(llm.requests.at(-1)!.purpose).toBe("turn-recheck");
    expect(llm.requests.at(-1)!.messages.at(-1)!.content).toContain("「牛肉麵」「很好吃」");
    expect(res.body.teacher).toMatchObject({ intent: "chinese_assistance", nextAction: "repeat_or_skip" });
    expect(res.body.session.questionIndex).toBe(0);

    // A word request answered with a sentence about asking (still holding Chinese) is re-checked.
    llm.reply(
      teacherJson({ teacherReply: "You can say: I want the word for 目的地.", intent: "chinese_assistance", nextAction: "repeat_or_skip", assistance: { english: "I want the word for 目的地." } }),
      teacherJson({ teacherReply: "It's destination. Can you use it in a sentence?", intent: "chinese_assistance", nextAction: "repeat_or_skip", assistance: { english: "destination" } }),
    );
    const word = await answer(id, "目的地的英文怎麼說？").expect(200);
    expect(llm.requests.at(-2)!.messages[0]!.content).toContain("English word for 「目的地」");
    expect(llm.requests.at(-1)!.purpose).toBe("turn-recheck");
    expect(word.body.teacher).toMatchObject({ text: "It's destination. Can you use it in a sentence?", assistance: { english: "destination" } });

    // A request said in Chinese is not re-checked.
    llm.reply(teacherJson({ intent: "request_repeat" }));
    await answer(id, "請再說一次").expect(200);
    expect(llm.requests.at(-1)!.purpose).toBe("turn");
  });

  it("completes the lesson when the student asks to stop, then refuses more turns", async () => {
    const { id } = await start();
    llm.reply(teacherJson({ teacherReply: "OK, see you next time!", intent: "request_end", nextAction: "end" }));
    const res = await answer(id, "Can we stop?").expect(200);
    expect(res.body.session).toMatchObject({ state: "completed", sectionId: null });

    const more = await answer(id, "Hello?").expect(409);
    expect(more.body.error.code).toBe("SESSION_NOT_ACTIVE");
  });

  it("validates turn input and reports missing sessions", async () => {
    const { id } = await start();
    await answer(id, "hi", { inputLanguage: "fr-FR" }).expect(400);
    expect((await answer("missing", "hi").expect(404)).body.error.code).toBe("SESSION_NOT_FOUND");
    expect((await request(app).post("/api/sessions").send({ lessonId: "nope" }).expect(404)).body.error.code).toBe(
      "LESSON_NOT_FOUND",
    );
  });

  it("works without an LLM configured: the lesson opens but turns explain the setup", async () => {
    app = createApp({ db, notion: null, llm: null });
    const session = (await request(app).post("/api/sessions").send({ lessonId }).expect(201)).body;
    expect(session.turns[0].degraded).toBe(true);
    expect((await answer(session.id, "hi").expect(503)).body.error.code).toBe("LLM_NOT_CONFIGURED");
    expect((await request(app).get("/api/llm/status").expect(200)).body).toMatchObject({ configured: false });
  });
});

describe("settings", () => {
  it("returns defaults, validates updates and snapshots them into new sessions", async () => {
    expect((await request(app).get("/api/settings").expect(200)).body).toEqual({
      correctionMode: "balanced",
      speechRate: 1,
      teachingLanguage: "english",
      studentLevel: "A2",
      locale: "zh-TW",
      sttLanguage: "en-US",
    });
    await request(app).put("/api/settings").send({ speechRate: 9 }).expect(400);
    await request(app).put("/api/settings").send({ apiKey: "x" }).expect(400);
    const updated = await request(app).put("/api/settings").send({ speechRate: 0.8, studentLevel: "B1" }).expect(200);
    expect(updated.body).toMatchObject({ speechRate: 0.8, studentLevel: "B1", correctionMode: "balanced" });

    const session = await start();
    expect((session as unknown as { settings: { studentLevel: string } }).settings.studentLevel).toBe("B1");
    expect(llm.requests[0]!.messages[0]!.content).toContain("CEFR B1");
  });
});
