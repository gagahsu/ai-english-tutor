import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/db.js";
import { getLesson, listLessons, updateSectionContent } from "../src/lessons/repository.js";
import { syncAllLessons, syncLesson } from "../src/lessons/sync.js";
import { block, FakeGateway, sampleLessonBlocks, toggleH1 } from "./fixtures.js";

let db: Db;
let notion: FakeGateway;

beforeEach(() => {
  db = openDatabase(":memory:");
  notion = new FakeGateway();
});

const sync = () => syncAllLessons(db, notion, "db-id", () => new Date("2026-10-23T00:00:00Z"));

describe("syncAllLessons", () => {
  it("imports lesson rows, skips non-lesson rows with a warning, and sorts by series/unit", async () => {
    notion.addLesson(" A2 基礎會話c 3/10", sampleLessonBlocks());
    notion.addLesson("Template", sampleLessonBlocks());
    notion.addLesson("A2 基礎會話b 8/10", [toggleH1("Warm-up", [block("paragraph", "Hi")])]);

    const result = await sync();

    expect(result.lessons.map((l) => [l.title, l.status])).toEqual([
      ["A2 基礎會話c 3/10", "created"],
      ["A2 基礎會話b 8/10", "created"],
    ]);
    expect(result.warnings).toEqual([{ message: expect.stringContaining("Template") }]);
    expect(listLessons(db).map((l) => l.title)).toEqual(["A2 基礎會話b 8/10", "A2 基礎會話c 3/10"]);

    const lesson = getLesson(db, result.lessons[0]!.id)!;
    expect(lesson).toMatchObject({ level: "A2", course: "基礎會話", series: "c", unit: 3, totalUnits: 10 });
    expect(lesson.sections.map((s) => s.extractionStatus)).toEqual(Array(6).fill("pending"));
  });

  it("does not re-read lessons whose last_edited_time is unchanged", async () => {
    notion.addLesson("A2 基礎會話c 3/10", sampleLessonBlocks());
    await sync();
    notion.blockTreeCalls = [];

    const result = await sync();

    expect(result.lessons[0]!.status).toBe("unchanged");
    expect(notion.blockTreeCalls).toEqual([]);
  });

  it("keeps ids and corrections across re-syncs and flags edited sections whose source changed", async () => {
    const row = notion.addLesson("A2 基礎會話c 3/10", sampleLessonBlocks());
    const first = await sync();
    const lessonId = first.lessons[0]!.id;
    const before = getLesson(db, lessonId)!;
    const warmUp = before.sections.find((s) => s.title === "Warm-up")!;
    const shortTalk = before.sections.find((s) => s.title === "Short Talk")!;
    const vocab = before.sections.find((s) => s.title === "Vocabulary")!;
    updateSectionContent(db, lessonId, warmUp.id, { prompts: ["How was your week?"], vocabulary: [], referenceAnswers: [] });
    updateSectionContent(db, lessonId, vocab.id, { prompts: ["Fixed"], vocabulary: [], referenceAnswers: [] });

    // Change Warm-up (edited by user) and Short Talk (not edited); drop Gramma.
    const blocks = notion.trees.get(row.pageId)!;
    (blocks[1]!.children![0]!.paragraph as { rich_text: unknown }).rich_text = [{ plain_text: "Changed" }];
    (blocks[2]!.children![1]!.paragraph as { rich_text: unknown }).rich_text = [{ plain_text: "Changed too" }];
    blocks.pop();
    row.lastEditedTime = "2026-10-02T00:00:00.000Z";

    const second = await sync();

    expect(second.lessons[0]).toMatchObject({ id: lessonId, status: "updated" });
    const after = getLesson(db, lessonId)!;
    const get = (id: string) => after.sections.find((s) => s.id === id)!;
    expect(get(warmUp.id)).toMatchObject({ extractionStatus: "needs_review", editedByUser: true, prompts: ["How was your week?"] });
    expect(get(shortTalk.id)).toMatchObject({ extractionStatus: "pending", editedByUser: false });
    expect(get(vocab.id)).toMatchObject({ extractionStatus: "done", prompts: ["Fixed"] });
    expect(after.sections.filter((s) => s.stale).map((s) => s.title)).toEqual(["Gramma"]);
  });

  it("marks lessons removed from Notion as stale and revives them when they come back", async () => {
    const removed = notion.addLesson("A2 基礎會話c 3/10", sampleLessonBlocks());
    await sync();
    notion.rows = [];

    const result = await sync();
    expect(result.lessons).toEqual([expect.objectContaining({ status: "stale" })]);
    expect(listLessons(db)[0]!.stale).toBe(true);

    notion.rows = [removed];
    const revived = await sync();
    expect(revived.lessons[0]!.status).toBe("updated");
    expect(listLessons(db)[0]!.stale).toBe(false);
  });

  it("rejects a second sync while one is running", async () => {
    notion.addLesson("A2 基礎會話c 3/10", sampleLessonBlocks());
    const first = sync();
    await expect(sync()).rejects.toMatchObject({ code: "SYNC_IN_PROGRESS" });
    await first;
  });
});

describe("syncLesson", () => {
  it("re-reads a single lesson even if unchanged", async () => {
    notion.addLesson("A2 基礎會話c 3/10", sampleLessonBlocks());
    const { lessons } = await sync();
    notion.blockTreeCalls = [];

    const result = await syncLesson(db, notion, lessons[0]!.id);

    expect(result.lessons[0]!.status).toBe("updated");
    expect(notion.blockTreeCalls).toHaveLength(1);
  });

  it("marks the lesson stale when the Notion page was trashed", async () => {
    const row = notion.addLesson("A2 基礎會話c 3/10", sampleLessonBlocks());
    const { lessons } = await sync();
    row.archived = true;

    const result = await syncLesson(db, notion, lessons[0]!.id);

    expect(result.lessons[0]!.status).toBe("stale");
    expect(getLesson(db, lessons[0]!.id)!.stale).toBe(true);
  });
});
