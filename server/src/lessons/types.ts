import { z } from "zod";

export const SECTION_KINDS = [
  "learning-materials",
  "warm-up",
  "short-talk",
  "vocabulary",
  "conversation",
  "reading",
  "grammar",
  "expression",
  "sentence-structure",
  "speaking",
  "discussion",
  "debate",
  "group-activity",
  "extended-learning",
  "other",
] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

export type ExtractionStatus = "pending" | "done" | "failed" | "needs_review";

export const vocabularyItemSchema = z.object({
  term: z.string().trim().min(1),
  meaningZh: z.string().trim().min(1).optional(),
});
export const referenceAnswerSchema = z.object({
  prompt: z.string().trim().min(1).optional(),
  answer: z.string().trim().min(1),
});
/** The fields an LLM extracts from a section's source, and that the user may correct by hand. */
export const sectionContentSchema = z.object({
  prompts: z.array(z.string().trim().min(1)),
  vocabulary: z.array(vocabularyItemSchema),
  referenceAnswers: z.array(referenceAnswerSchema),
});
export type VocabularyItem = z.infer<typeof vocabularyItemSchema>;
export type ReferenceAnswer = z.infer<typeof referenceAnswerSchema>;
export type SectionContent = z.infer<typeof sectionContentSchema>;

export interface Resource {
  kind: "pdf" | "file" | "image" | "video" | "audio" | "link";
  blockId: string;
  name?: string;
  /** Only stored for external links; Notion-hosted file URLs expire and are re-fetched on demand. */
  url?: string;
  hosted: boolean;
}

export interface Section extends SectionContent {
  id: string;
  lessonId: string;
  notionBlockId: string | null;
  position: number;
  kind: SectionKind;
  title: string;
  sourceMarkdown: string;
  sourceHash: string;
  resources: Resource[];
  extractionStatus: ExtractionStatus;
  editedByUser: boolean;
  stale: boolean;
}

export interface LessonSummary {
  id: string;
  notionPageId: string | null;
  title: string;
  level: string | null;
  course: string | null;
  series: string | null;
  unit: number | null;
  totalUnits: number | null;
  topic: string | null;
  notionLastEditedAt: string | null;
  lastSyncedAt: string;
  stale: boolean;
}

export interface Lesson extends LessonSummary {
  sections: Section[];
}

export interface SyncWarning {
  lessonTitle?: string;
  message: string;
}
