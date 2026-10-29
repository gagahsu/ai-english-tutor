import type { Lesson, Section } from "../lessons/types.js";
import type { Correction, Intent, NextAction, Progress, TeacherOutput } from "./types.js";

// The teacher controller owns lesson progression (CLAUDE.md, SRS §2 step 5). The model only
// proposes a next action; these pure functions decide what actually happens to Progress.

/** Follow-ups, hints and corrections allowed on one question before moving on. */
export const MAX_FOLLOW_UPS = 2;
/** Questions per section when extraction has not produced prompts and the teacher works from the source. */
export const FALLBACK_QUESTIONS_PER_SECTION = 3;

const NON_TEACHING_KINDS = new Set(["learning-materials"]);

export interface Step {
  section: Section;
  questionIndex: number;
  /** Null when the section has no extracted prompts; the teacher picks from its source. */
  question: string | null;
}

export interface TurnPlan {
  current: Step;
  /** Where "advance" leads; null when the current question is the last of the lesson. */
  next: Step | null;
  followUps: number;
  /** The question has used up its follow-ups; the teacher must move on. */
  mustAdvance: boolean;
  pendingAssistance: string | null;
}

export interface Decision {
  progress: Progress;
  nextAction: NextAction;
  /** Text the controller adds to the reply when it overrode the model, e.g. the next question. */
  replySuffix: string | null;
  /** The question the lesson moves to on "advance" (also the one inside replySuffix), if known. */
  nextQuestion: string | null;
  lessonCompleted: boolean;
}

export function teachableSections(lesson: Lesson): Section[] {
  return lesson.sections
    .filter((s) => !s.stale && !NON_TEACHING_KINDS.has(s.kind))
    .sort((a, b) => a.position - b.position);
}

const questionCount = (s: Section) => s.prompts.length || FALLBACK_QUESTIONS_PER_SECTION;

const step = (section: Section, questionIndex: number): Step => ({
  section,
  questionIndex,
  question: section.prompts[questionIndex] ?? null,
});

export function initialProgress(lesson: Lesson, sectionId?: string): Progress | null {
  const sections = teachableSections(lesson);
  // Warm-up first when present (AT-02); otherwise the first teachable section.
  const first = sectionId
    ? sections.find((s) => s.id === sectionId)
    : (sections.find((s) => s.kind === "warm-up") ?? sections[0]);
  return first ? { sectionId: first.id, questionIndex: 0, followUps: 0, pendingAssistance: null } : null;
}

/**
 * Resolves Progress against the current lesson snapshot. A re-sync may have made the section
 * stale or shortened its prompts; then teaching continues at the next valid position.
 */
export function currentStep(lesson: Lesson, p: Progress): Step | null {
  if (!p.sectionId) return null;
  const sections = teachableSections(lesson);
  const section = sections.find((s) => s.id === p.sectionId);
  if (section) {
    if (p.questionIndex < questionCount(section)) return step(section, p.questionIndex);
    return firstStepAfter(sections, section.position);
  }
  const gone = lesson.sections.find((s) => s.id === p.sectionId);
  return gone ? firstStepAfter(sections, gone.position) : (sections[0] ? step(sections[0], 0) : null);
}

function firstStepAfter(sections: Section[], position: number): Step | null {
  const next = sections.find((s) => s.position > position);
  return next ? step(next, 0) : null;
}

export function planTurn(lesson: Lesson, p: Progress): TurnPlan | null {
  const current = currentStep(lesson, p);
  if (!current) return null;
  const sections = teachableSections(lesson);
  const next =
    current.questionIndex + 1 < questionCount(current.section)
      ? step(current.section, current.questionIndex + 1)
      : firstStepAfter(sections, current.section.position);
  // A stale-section jump resets the counters for the new position.
  const moved = current.section.id !== p.sectionId || current.questionIndex !== p.questionIndex;
  const followUps = moved ? 0 : p.followUps;
  return {
    current,
    next,
    followUps,
    mustAdvance: followUps >= MAX_FOLLOW_UPS,
    pendingAssistance: moved ? null : p.pendingAssistance,
  };
}

const toProgress = (s: Step): Progress => ({
  sectionId: s.section.id,
  questionIndex: s.questionIndex,
  followUps: 0,
  pendingAssistance: null,
});

const FINISHED: Progress = { sectionId: null, questionIndex: 0, followUps: 0, pendingAssistance: null };

/** The plan's position with nothing spent, for a turn whose reply could not be understood. */
export function holdPosition(plan: TurnPlan): Progress {
  return {
    sectionId: plan.current.section.id,
    questionIndex: plan.current.questionIndex,
    followUps: plan.followUps,
    pendingAssistance: plan.pendingAssistance,
  };
}

/** Applies the model's proposal to the plan, overriding it where it breaks the lesson rules. */
export function decide(plan: TurnPlan, out: Pick<TeacherOutput, "intent" | "nextAction" | "assistance">): Decision {
  let action: NextAction = out.nextAction;
  let forced = false;
  if (out.intent === "chinese_assistance" && out.assistance) action = "repeat_or_skip";
  if (out.intent === "request_end") action = "end";
  // Only the student, or running out of questions, ends the lesson.
  else if (action === "end" && plan.next) {
    action = "advance";
    forced = true;
  }
  if (plan.mustAdvance && (action === "follow_up" || action === "hint" || action === "correct")) {
    action = "advance";
    forced = true;
  }

  const stay = (changes: Partial<Progress>): Progress => ({
    sectionId: plan.current.section.id,
    questionIndex: plan.current.questionIndex,
    followUps: plan.followUps,
    pendingAssistance: null,
    ...changes,
  });

  switch (action) {
    case "repeat_or_skip":
      // Chinese help is not an answer attempt: it costs no follow-up (SRS §4.4).
      return {
        progress: stay({ pendingAssistance: out.assistance?.english ?? plan.pendingAssistance }),
        nextAction: action,
        replySuffix: null,
        nextQuestion: null,
        lessonCompleted: false,
      };
    case "confirm_transcript":
      return {
        progress: stay({ pendingAssistance: plan.pendingAssistance }),
        nextAction: action,
        replySuffix: null,
        nextQuestion: null,
        lessonCompleted: false,
      };
    case "follow_up":
    case "hint":
    case "correct":
      return {
        progress: stay({ followUps: plan.followUps + 1 }),
        nextAction: action,
        replySuffix: null,
        nextQuestion: null,
        lessonCompleted: false,
      };
    case "advance":
      if (!plan.next) {
        return {
          progress: FINISHED,
          nextAction: "end",
          replySuffix: forced ? CLOSING : null,
          nextQuestion: null,
          lessonCompleted: true,
        };
      }
      return {
        progress: toProgress(plan.next),
        nextAction: action,
        replySuffix: forced ? announce(plan.current, plan.next) : null,
        nextQuestion: plan.next.question,
        lessonCompleted: false,
      };
    case "end":
      return { progress: FINISHED, nextAction: action, replySuffix: null, nextQuestion: null, lessonCompleted: true };
  }
}

const CLOSING = "That's the end of today's lesson. Great job!";

/** Deterministic wording for a move the model did not make itself. */
export function announce(from: Step | null, to: Step): string {
  const intro = from?.section.id === to.section.id ? "Next question:" : `Let's move on to ${to.section.title}.`;
  return to.question ? `${intro} ${to.question}` : intro;
}

/**
 * Balanced correction (SRS §4.3): at most one blocking error is corrected now; everything else
 * is deferred to the summary. Unverified STT text is never graded (FR-05), and neither is a
 * Chinese-help turn or a suspected mishearing.
 */
export function filterCorrections(
  corrections: Correction[],
  ctx: { verifiedByStudent: boolean; intent: Intent | null; nextAction: NextAction },
): (Correction & { deferred: boolean })[] {
  if (!ctx.verifiedByStudent || ctx.nextAction === "confirm_transcript") return [];
  let immediateUsed = ctx.intent === "chinese_assistance";
  return corrections.map((c) => {
    const immediate = c.severity === "blocking" && !immediateUsed;
    if (immediate) immediateUsed = true;
    return { ...c, deferred: !immediate };
  });
}
