import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDatabase, type Db } from "../src/db.js";
import { tidy, WARM_UP_PROMPTS } from "../src/lessons/extract.js";
import { getLesson, saveExtraction, updateSectionContent } from "../src/lessons/repository.js";
import { syncAllLessons } from "../src/lessons/sync.js";
import { FakeGateway, FakeLlm, sampleLessonBlocks } from "./fixtures.js";

let db: Db;
let llm: FakeLlm;
let notion: FakeGateway;
let app: ReturnType<typeof createApp>;
let lessonId: string;

const extracted = (prompt: string) =>
  JSON.stringify({ prompts: [prompt], vocabulary: [{ term: "suitcase", meaningZh: "" }], referenceAnswers: [{ prompt: null, answer: "ANS" }] });

beforeEach(async () => {
  db = openDatabase(":memory:");
  notion = new FakeGateway();
  notion.addLesson("A2 基礎會話c 3/10", sampleLessonBlocks());
  lessonId = (await syncAllLessons(db, notion, "db-id")).lessons[0]!.id;
  llm = new FakeLlm();
  app = createApp({ db, notion: { gateway: notion, databaseId: "db-id" }, llm });
});

const sections = () => getLesson(db, lessonId)!.sections;

describe("section extraction", () => {
  it("extracts every pending section once and skips Learning materials", async () => {
    llm.reply(...Array.from({ length: 5 }, (_, i) => extracted(`Q${i}`)));

    const res = await request(app).post(`/api/lessons/${lessonId}/extract`).send({}).expect(200);

    expect(llm.requests).toHaveLength(5);
    expect(llm.requests.every((r) => r.json && r.purpose === "extract")).toBe(true);
    expect(res.body.sections.every((s: { extractionStatus: string }) => s.extractionStatus === "done")).toBe(true);
    expect(sections().find((s) => s.title === "Short Talk")).toMatchObject({
      prompts: ["Q1"],
      vocabulary: [{ term: "suitcase" }],
      referenceAnswers: [{ answer: "ANS" }],
      editedByUser: false,
    });
    expect(sections().find((s) => s.kind === "learning-materials")!.prompts).toEqual([]);

    // Warm-up is small talk: fixed open questions, the diary kept as teacher-only background.
    expect(sections().find((s) => s.title === "Warm-up")).toMatchObject({ prompts: WARM_UP_PROMPTS, referenceAnswers: [{ answer: "ANS" }] });
    expect(llm.requests[0]!.messages[1]!.content).toContain("the notes are the student's own diary");
    expect(llm.requests[1]!.messages[1]!.content).not.toContain("diary");

    await request(app).post(`/api/lessons/${lessonId}/extract`).send({}).expect(200);
    expect(llm.requests).toHaveLength(5);
  });

  it("marks a section failed after two invalid replies and retries it on the next call", async () => {
    llm.reply("nope", '{"prompts": "x"}', ...Array.from({ length: 4 }, () => extracted("Q")));
    await request(app).post(`/api/lessons/${lessonId}/extract`).expect(200);
    expect(sections().filter((s) => s.extractionStatus === "failed").map((s) => s.title)).toEqual(["Warm-up"]);

    llm.reply(extracted("Q"));
    await request(app).post(`/api/lessons/${lessonId}/extract`).expect(200);
    expect(sections().every((s) => s.extractionStatus === "done")).toBe(true);
  });

  it("keeps progress made before an LLM error", async () => {
    llm.reply(extracted("Q"), new Error("boom"));
    await request(app).post(`/api/lessons/${lessonId}/extract`).expect(500);
    expect(sections().filter((s) => s.extractionStatus === "done").map((s) => s.title)).toEqual([
      "Learning materials",
      "Warm-up",
    ]);
  });

  it("asks before replacing a correction whose Notion source changed", async () => {
    llm.reply(...Array.from({ length: 5 }, () => extracted("Q")));
    await request(app).post(`/api/lessons/${lessonId}/extract`).expect(200);
    const shortTalk = sections().find((s) => s.title === "Short Talk")!;
    const vocab = sections().find((s) => s.title === "Vocabulary")!;
    for (const s of [shortTalk, vocab]) {
      updateSectionContent(db, lessonId, s.id, { prompts: ["Mine"], vocabulary: [], referenceAnswers: [] });
    }
    // Edit both sections in Notion and re-sync: both now need review.
    const row = notion.rows[0]!;
    const tree = notion.trees.get(row.pageId)!;
    tree[2]!.children![1]!.paragraph = { rich_text: [{ plain_text: "Changed short talk" }] };
    tree[3]!.children![0]!.bulleted_list_item = { rich_text: [{ plain_text: "Changed vocab" }] };
    row.lastEditedTime = "2026-10-02T00:00:00.000Z";
    await syncAllLessons(db, notion, "db-id");
    expect(sections().filter((s) => s.extractionStatus === "needs_review")).toHaveLength(2);

    await request(app).post(`/api/lessons/${lessonId}/extract`).send({}).expect(200);
    expect(llm.requests).toHaveLength(5);

    llm.reply(extracted("New"));
    await request(app).post(`/api/lessons/${lessonId}/extract`).send({ reextract: [shortTalk.id] }).expect(200);
    expect(sections().find((s) => s.id === shortTalk.id)).toMatchObject({ prompts: ["New"], editedByUser: false, extractionStatus: "done" });

    const kept = await request(app).post(`/api/lessons/${lessonId}/sections/${vocab.id}/keep-correction`).expect(200);
    expect(kept.body).toMatchObject({ prompts: ["Mine"], editedByUser: true, extractionStatus: "done" });
    await request(app).post(`/api/lessons/${lessonId}/sections/${vocab.id}/keep-correction`).expect(409);
  });

  it("drops a result whose section was re-synced with a different source meanwhile", () => {
    const s = sections()[1]!;
    expect(saveExtraction(db, s.id, "old-hash", { prompts: ["Q"], vocabulary: [], referenceAnswers: [] })).toBe(false);
    expect(sections()[1]!.extractionStatus).toBe("pending");
  });

  it("needs an LLM", async () => {
    app = createApp({ db, notion: null, llm: null });
    expect((await request(app).post(`/api/lessons/${lessonId}/extract`).expect(503)).body.error.code).toBe("LLM_NOT_CONFIGURED");
  });
});

describe("tidy", () => {
  it("strips Markdown and drops repeated questions", () => {
    const content = tidy(
      { kind: "conversation" },
      {
        prompts: ["What is a **stopover**?", "What is a stopover ?", "Where is `Gate B5`?"],
        vocabulary: [{ term: "**suitcase**", meaningZh: "行李箱" }],
        referenceAnswers: [{ prompt: "What is a **stopover**?", answer: "A **short** stay." }],
      },
    );
    expect(content).toEqual({
      prompts: ["What is a stopover?", "Where is Gate B5?"],
      vocabulary: [{ term: "suitcase", meaningZh: "行李箱" }],
      referenceAnswers: [{ prompt: "What is a stopover?", answer: "A short stay." }],
    });
  });
});
