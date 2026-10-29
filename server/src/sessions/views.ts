import type { Lesson } from "../lessons/types.js";
import type { FeedbackRecord, Session, TurnRecord } from "./types.js";

// Student-facing projections. Deferred corrections stay out until the after-class summary,
// and nothing here reads the section source or answer key.

export function toTurnView(t: TurnRecord, feedback: FeedbackRecord[]) {
  if (t.role === "teacher") {
    return {
      id: t.id,
      role: t.role,
      text: t.teacherText ?? "",
      lessonSectionId: t.sectionId,
      intent: t.meta?.intent ?? null,
      nextAction: t.meta?.nextAction ?? null,
      assistance: t.meta?.assistance ?? null,
      degraded: t.meta?.degraded ?? false,
      createdAt: t.createdAt,
    };
  }
  return {
    id: t.id,
    role: t.role,
    text: t.transcript ?? "",
    requestId: t.requestId,
    inputLanguage: t.inputLanguage,
    verifiedByStudent: t.verifiedByStudent,
    corrections: feedback
      .filter((f) => f.turnId === t.id && !f.deferred)
      .map((f) => ({ type: f.type, original: f.original, suggestion: f.suggestion, reasonZh: f.reasonZh })),
    createdAt: t.createdAt,
  };
}

export function toProgressView(session: Session, lesson: Lesson) {
  const section = lesson.sections.find((s) => s.id === session.progress.sectionId);
  return {
    id: session.id,
    state: session.state,
    sectionId: section?.id ?? null,
    sectionTitle: section?.title ?? null,
    questionIndex: session.progress.questionIndex,
  };
}

export function toSessionView(session: Session, lesson: Lesson, turns: TurnRecord[], feedback: FeedbackRecord[]) {
  return {
    ...toProgressView(session, lesson),
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    settings: session.settings,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    turns: turns.map((t) => toTurnView(t, feedback)),
    // The summary is the student's own review, deferred corrections included.
    summary: session.summary,
  };
}

export function toSessionListItem(session: Session, lesson: Lesson, answers: number) {
  return {
    ...toProgressView(session, lesson),
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    answers,
    hasSummary: !!session.summary,
  };
}
