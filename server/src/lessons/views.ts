import type { Lesson, LessonSummary, Resource } from "./types.js";

// Student-facing projections (SRS §6.4). Anything not copied here explicitly — notably
// sourceMarkdown and referenceAnswers — never leaves the backend through these views.

export function toStudentLessonSummary(l: LessonSummary) {
  return {
    id: l.id,
    title: l.title,
    level: l.level,
    course: l.course,
    series: l.series,
    unit: l.unit,
    totalUnits: l.totalUnits,
    stale: l.stale,
    lastSyncedAt: l.lastSyncedAt,
  };
}

export function toStudentLesson(l: Lesson) {
  return {
    ...toStudentLessonSummary(l),
    sections: l.sections
      .filter((s) => !s.stale)
      .map((s) => ({
        id: s.id,
        kind: s.kind,
        title: s.title,
        prompts: s.prompts,
        vocabulary: s.vocabulary.map((v) => ({ term: v.term, meaningZh: v.meaningZh })),
        resources: s.resources.map(toStudentResource),
      })),
  };
}

function toStudentResource(r: Resource) {
  return {
    kind: r.kind,
    name: r.name,
    url: r.hosted ? `/api/resources/${r.blockId}` : r.url,
  };
}
