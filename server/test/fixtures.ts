import type { CompletionRequest, LlmProvider } from "../src/llm/provider.js";
import type { LessonRow, NotionGateway } from "../src/notion/gateway.js";
import type { RawBlock } from "../src/notion/markdown.js";

let seq = 0;
export const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

export const rt = (text: string, extra: Record<string, unknown> = {}) => [{ plain_text: text, ...extra }];

export function block(type: string, text = "", data: Record<string, unknown> = {}, children?: RawBlock[]): RawBlock {
  return { id: id(), type, has_children: !!children?.length, children, [type]: { rich_text: rt(text), ...data } };
}

export const toggleH1 = (title: string, children: RawBlock[]) =>
  block("heading_1", title, { is_toggleable: true }, children);

export class FakeGateway implements NotionGateway {
  rows: LessonRow[] = [];
  trees = new Map<string, RawBlock[]>();
  blockTreeCalls: string[] = [];

  addLesson(title: string, blocks: RawBlock[], lastEditedTime = "2026-10-01T00:00:00.000Z"): LessonRow {
    const row = { pageId: id(), title, lastEditedTime, archived: false };
    this.rows.push(row);
    this.trees.set(row.pageId, blocks);
    return row;
  }

  async getDatabaseTitle() {
    return "Language bar";
  }
  async listLessonRows() {
    return this.rows.map((r) => ({ ...r }));
  }
  async getLessonRow(pageId: string) {
    const row = this.rows.find((r) => r.pageId === pageId);
    if (!row) throw new Error("not found");
    return { ...row };
  }
  async getBlockTree(pageId: string) {
    this.blockTreeCalls.push(pageId);
    return structuredClone(this.trees.get(pageId) ?? []);
  }
  async getFileUrl(blockId: string) {
    return `https://files.example.com/${blockId}.pdf?signed=1`;
  }
}

/** A lesson shaped like the real pages: toggle headings, a stray block, a template leftover. */
export function sampleLessonBlocks(): RawBlock[] {
  return [
    toggleH1("Learning materials", [block("pdf", "", { type: "file", file: { url: "https://s3.example.com/x.pdf" }, name: "worksheet.pdf" })]),
    toggleH1("Warm-up", [block("paragraph", "Tell me about your week.")]),
    toggleH1("Short Talk", [
      block("heading_2", "Have you ever traveled abroad?"),
      block("paragraph", "Yes, I have been to Japan."),
    ]),
    toggleH1("Vocabulary", [
      block("bulleted_list_item", "a) suitcase：行李箱"),
      block("numbered_list_item", "( a ) A bag for clothes.", {}, [block("bulleted_list_item", "答案：a) suitcase")]),
    ]),
    toggleH1("GROUP ACTIVITY", [block("paragraph", "Describe the pictures.")]),
    block("paragraph", "SPEAKING: What items are prohibited?"),
    toggleH1("Extended Learning", [block("paragraph", "Extended Learning")]),
    toggleH1("Gramma", [block("paragraph", "Use some in positive sentences.")]),
  ];
}

type FakeReply = string | Error | ((req: CompletionRequest) => string);

/** Replies are consumed in order; every request is recorded for assertions. */
export class FakeLlm implements LlmProvider {
  model = "fake-model";
  requests: CompletionRequest[] = [];
  private queue: FakeReply[] = [];

  reply(...replies: FakeReply[]): this {
    this.queue.push(...replies);
    return this;
  }
  async complete(req: CompletionRequest) {
    this.requests.push(structuredClone(req));
    const next = this.queue.shift();
    if (next === undefined) throw new Error("FakeLlm: no reply queued");
    if (next instanceof Error) throw next;
    return { text: typeof next === "function" ? next(req) : next };
  }
}

export const teacherJson = (out: Record<string, unknown> = {}) =>
  JSON.stringify({ teacherReply: "Nice! Tell me more.", intent: "answer", nextAction: "follow_up", corrections: [], assistance: null, ...out });
