import { z } from "zod";
import type { Settings } from "../settings.js";

export const INTENTS = [
  "answer",
  "chinese_assistance",
  "request_repeat",
  "request_skip",
  "request_explain",
  "request_end",
  "other",
] as const;
export type Intent = (typeof INTENTS)[number];

export const NEXT_ACTIONS = [
  "follow_up",
  "hint",
  "correct",
  "advance",
  "repeat_or_skip",
  "confirm_transcript",
  "end",
] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

const correctionSchema = z.object({
  type: z.enum(["grammar", "vocabulary", "expression"]).catch("grammar"),
  original: z.string().trim().min(1).max(500),
  suggestion: z.string().trim().min(1).max(500),
  reasonZh: z.string().trim().max(500).optional(),
  severity: z.enum(["blocking", "minor"]).catch("minor"),
});
export type Correction = z.infer<typeof correctionSchema>;

const assistanceSchema = z.object({
  english: z.string().trim().min(1).max(500),
  zhExplanation: z.string().trim().max(500).optional(),
});
export type Assistance = z.infer<typeof assistanceSchema>;

/**
 * The model's reply format (SRS §8). Unknown enum values fall back instead of failing,
 * because the controller re-checks the action anyway; only a missing reply forces a retry.
 */
export const teacherOutputSchema = z.object({
  teacherReply: z.string().trim().min(1).max(1_000),
  intent: z.enum(INTENTS).catch("other"),
  nextAction: z.enum(NEXT_ACTIONS).catch("follow_up"),
  lessonSectionId: z.string().optional(),
  corrections: z.array(correctionSchema).max(5).catch([]),
  assistance: assistanceSchema.optional().catch(undefined),
});
export type TeacherOutput = z.infer<typeof teacherOutputSchema>;

export const createSessionSchema = z.object({
  lessonId: z.string().min(1),
  /** Start at this section instead of the first teachable one. */
  sectionId: z.string().min(1).optional(),
});

export const turnInputSchema = z.object({
  /** Client-generated id; resubmitting the same id returns the stored reply instead of a new one. */
  requestId: z.string().trim().min(1).max(100),
  text: z.string().trim().min(1).max(2_000),
  inputLanguage: z.enum(["en-US", "zh-TW"]),
  /** False for STT text the student did not review; it is never graded (FR-05). */
  verifiedByStudent: z.boolean(),
});
export type TurnInput = z.infer<typeof turnInputSchema>;

export type SessionState = "active" | "completed" | "finished";

/** The teacher controller's position in the lesson; see controller.ts. */
export interface Progress {
  /** Null once the lesson has run out of sections. */
  sectionId: string | null;
  /** Index into the section's prompts, or questions asked so far when it has none. */
  questionIndex: number;
  /** Follow-ups, hints and corrections spent on the current question. */
  followUps: number;
  /** English phrasing offered in the last turn that the student was asked to repeat. */
  pendingAssistance: string | null;
}

export interface Session {
  id: string;
  lessonId: string;
  state: SessionState;
  progress: Progress;
  settings: Settings;
  startedAt: string;
  endedAt: string | null;
  summary: SessionSummary | null;
}

/**
 * After-class review (FR-11). Corrections, phrases and vocabulary come straight from stored
 * data; only the overview, the more natural phrasings and the next steps are written by the LLM.
 */
export interface SessionSummary {
  generatedAt: string;
  /** True when the LLM was unavailable and the text parts are a fixed fallback. */
  degraded: boolean;
  overviewZh: string;
  sectionsCovered: { id: string; title: string }[];
  stats: { answers: number; chineseHelp: number; corrections: number };
  corrections: { type: string; original: string; suggestion: string; reasonZh: string | null }[];
  naturalExpressions: { original: string; better: string; noteZh?: string }[];
  /** English the teacher offered during Chinese help. */
  phrases: { english: string; zhExplanation?: string }[];
  vocabulary: { term: string; meaningZh?: string }[];
  nextSteps: string[];
}

/** What the web client sends when the student skips repeating an offered sentence (web SKIP_REPEAT_TEXT). */
export const SKIP_REPEAT_PREFIX = "Skip repeating";

export interface TeacherMeta {
  intent: Intent | null;
  nextAction: NextAction;
  assistance?: Assistance;
  /** True when the model's output was unusable and a fallback reply was sent. */
  degraded?: boolean;
}

export interface TurnRecord {
  id: string;
  seq: number;
  role: "teacher" | "student";
  sectionId: string | null;
  requestId: string | null;
  inReplyTo: string | null;
  inputLanguage: string | null;
  transcript: string | null;
  verifiedByStudent: boolean | null;
  teacherText: string | null;
  meta: TeacherMeta | null;
  createdAt: string;
}

export interface FeedbackRecord {
  id: string;
  turnId: string;
  type: string;
  original: string;
  suggestion: string;
  reasonZh: string | null;
  deferred: boolean;
  reviewStatus: string;
}
