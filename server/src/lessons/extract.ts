import { z } from "zod";
import type { Db } from "../db.js";
import { AppError } from "../errors.js";
import type { LlmProvider } from "../llm/provider.js";
import { completeStructured } from "../llm/structured.js";
import { getLesson, saveExtraction } from "./repository.js";
import { sectionContentSchema, type ExtractionStatus, type Section, type SectionContent } from "./types.js";

// Sections that only hold links or leftovers; nothing to ask about.
const SKIPPED_KINDS = new Set(["learning-materials"]);
const MAX_SOURCE_CHARS = 12_000;

// Warm-up is small talk about the student's week. Its notes are an old diary entry, which the
// teacher keeps as background (referenceAnswers) instead of turning it into quiz questions.
export const WARM_UP_PROMPTS = ["How was your week?", "What did you do last weekend?", "What are your plans for this week?"];

const extractionSchema = sectionContentSchema.extend({
  prompts: sectionContentSchema.shape.prompts.max(40),
  vocabulary: sectionContentSchema.shape.vocabulary.max(80),
  referenceAnswers: sectionContentSchema.shape.referenceAnswers.max(60),
});

export const extractRequestSchema = z.object({
  /** Sections in `needs_review` the user chose to re-extract, discarding their correction. */
  reextract: z.array(z.string()).default([]),
});

export interface ExtractResult {
  sections: { id: string; title: string; extractionStatus: ExtractionStatus }[];
}

const running = new Set<string>();

/**
 * Runs the one-time LLM extraction (SRS §6.4) for a lesson's sections that are `pending`
 * or `failed`, plus `needs_review` ones listed in `reextract`. Each section is saved as soon
 * as it is done, so a call interrupted by a rate limit resumes where it stopped.
 */
export async function extractLesson(db: Db, llm: LlmProvider, lessonId: string, reextract: string[] = []): Promise<ExtractResult> {
  if (running.has(lessonId)) throw new AppError(409, "EXTRACTION_IN_PROGRESS", "這堂課正在整理教材，請稍候。");
  const lesson = getLesson(db, lessonId);
  if (!lesson) throw new AppError(404, "LESSON_NOT_FOUND", "找不到這堂課。");
  running.add(lessonId);
  try {
    const todo = lesson.sections.filter(
      (s) =>
        !s.stale &&
        (s.extractionStatus === "pending" ||
          s.extractionStatus === "failed" ||
          (s.extractionStatus === "needs_review" && reextract.includes(s.id))),
    );
    for (const section of todo) {
      if (SKIPPED_KINDS.has(section.kind) || !section.sourceMarkdown.trim()) {
        saveExtraction(db, section.id, section.sourceHash, tidy(section, { prompts: [], vocabulary: [], referenceAnswers: [] }));
        continue;
      }
      const result = await completeStructured(
        llm,
        { messages: extractionMessages(lesson.title, section), maxTokens: 4_000, temperature: 0, purpose: "extract" },
        extractionSchema,
      );
      saveExtraction(db, section.id, section.sourceHash, result.ok ? tidy(section, result.value) : null);
    }
    const after = getLesson(db, lessonId)!;
    return {
      sections: after.sections
        .filter((s) => !s.stale)
        .map((s) => ({ id: s.id, title: s.title, extractionStatus: s.extractionStatus })),
    };
  } finally {
    running.delete(lessonId);
  }
}

/** Strips Markdown the model copies from the notes and drops repeated questions. */
export function tidy(section: Pick<Section, "kind">, content: SectionContent): SectionContent {
  const clean = (text: string) => text.replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim();
  const seen = new Set<string>();
  const prompts = content.prompts.map(clean).filter((p) => {
    const key = p.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    prompts: section.kind === "warm-up" ? WARM_UP_PROMPTS : prompts,
    vocabulary: content.vocabulary
      .map((v) => ({ term: clean(v.term), ...(v.meaningZh ? { meaningZh: clean(v.meaningZh) } : {}) }))
      .filter((v) => v.term),
    referenceAnswers: content.referenceAnswers
      .map((r) => ({ ...(r.prompt ? { prompt: clean(r.prompt) } : {}), answer: clean(r.answer) }))
      .filter((r) => r.answer),
  };
}

function extractionMessages(lessonTitle: string, section: Section) {
  const warmUp =
    section.kind === "warm-up"
      ? 'This is a Warm-up section: the notes are the student\'s own diary. Return "prompts": [] and put each diary sentence or paragraph in "referenceAnswers" (answer only, no prompt).\n'
      : "";
  return [
    {
      role: "system" as const,
      content: `You prepare material for an English teacher. You get one section of a student's lesson notes
(Markdown, English and Traditional Chinese mixed). The notes are mostly an answer key plus personal notes;
nothing marks which text is a question and which is an answer. Extract:

- "prompts": questions or tasks the teacher can ask the student in this section, in English, in lesson order.
  Rewrite fill-in-the-blank or matching items as a clear spoken question. Do not include the answer in the prompt.
- "vocabulary": words or phrases being taught, as {"term": English, "meaningZh": Traditional Chinese meaning if the notes give one}.
- "referenceAnswers": model answers, correct answers and the student's own earlier answers,
  as {"prompt": the question it answers (if known), "answer": the answer text}.

Only use what is in the notes; do not invent content. Do not list the same question twice, even reworded.
Write plain text without Markdown (no **bold**). Use empty arrays for anything the section does not have.
Reply with only a JSON object: {"prompts": [...], "vocabulary": [...], "referenceAnswers": [...]}`,
    },
    {
      role: "user" as const,
      content: `Lesson: ${lessonTitle}\nSection: ${section.title}\n${warmUp}\n${section.sourceMarkdown.slice(0, MAX_SOURCE_CHARS)}`,
    },
  ];
}
