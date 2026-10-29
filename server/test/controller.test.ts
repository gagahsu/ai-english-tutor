import { describe, expect, it } from "vitest";
import type { Lesson, Section, SectionKind } from "../src/lessons/types.js";
import {
  FALLBACK_QUESTIONS_PER_SECTION,
  MAX_FOLLOW_UPS,
  currentStep,
  decide,
  filterCorrections,
  initialProgress,
  planTurn,
  questionSimilarity,
  reconcile,
  type Decision,
} from "../src/sessions/controller.js";
import { composeReply, concise, newCorrections, openingReply } from "../src/sessions/engine.js";
import { wordRequest } from "../src/sessions/prompt.js";
import type { Progress, TeacherOutput } from "../src/sessions/types.js";

function section(position: number, kind: SectionKind, title: string, prompts: string[] = [], stale = false): Section {
  return {
    id: `s${position}`,
    lessonId: "l1",
    notionBlockId: `b${position}`,
    position,
    kind,
    title,
    sourceMarkdown: `${title} notes`,
    sourceHash: "h",
    prompts,
    vocabulary: [],
    referenceAnswers: [],
    resources: [],
    extractionStatus: prompts.length ? "done" : "pending",
    editedByUser: false,
    stale,
  };
}

function lesson(sections: Section[]): Lesson {
  return {
    id: "l1",
    notionPageId: "p1",
    title: "A2 基礎會話c 3/10",
    level: "A2",
    course: "基礎會話",
    series: "c",
    unit: 3,
    totalUnits: 10,
    topic: null,
    notionLastEditedAt: null,
    lastSyncedAt: "2026-10-23T00:00:00Z",
    stale: false,
    sections,
  };
}

const sample = () =>
  lesson([
    section(0, "learning-materials", "Learning materials"),
    section(1, "short-talk", "Short Talk", ["Have you traveled abroad?"]),
    section(2, "warm-up", "Warm-up", ["How was your week?", "What did you eat?"]),
  ]);

const out = (o: Partial<TeacherOutput>): Pick<TeacherOutput, "intent" | "nextAction" | "assistance"> => ({
  intent: "answer",
  nextAction: "follow_up",
  ...o,
});

const at = (sectionId: string, questionIndex = 0, extra: Partial<Progress> = {}): Progress => ({
  sectionId,
  questionIndex,
  followUps: 0,
  pendingAssistance: null,
  ...extra,
});

describe("teacher controller", () => {
  it("starts at Warm-up and never teaches Learning materials", () => {
    expect(initialProgress(sample())).toEqual(at("s2"));
    expect(initialProgress(lesson([section(0, "learning-materials", "Learning materials")]))).toBeNull();
    expect(initialProgress(sample(), "s1")).toEqual(at("s1"));
  });

  it("counts follow-ups and forces an advance once they are used up", () => {
    const l = sample();
    let p = at("s2");
    for (let i = 0; i < MAX_FOLLOW_UPS; i++) {
      const d = decide(planTurn(l, p)!, out({ nextAction: "hint" }));
      expect(d.nextAction).toBe("hint");
      p = d.progress;
    }
    expect(p.followUps).toBe(MAX_FOLLOW_UPS);

    const plan = planTurn(l, p)!;
    expect(plan.mustAdvance).toBe(true);
    const d = decide(plan, out({ nextAction: "follow_up" }));
    expect(d).toMatchObject({ nextAction: "advance", replySuffix: "Next question: What did you eat?", progress: at("s2", 1) });
  });

  it("moves through questions, then to the next section by position", () => {
    const l = sample();
    const d1 = decide(planTurn(l, at("s2"))!, out({ nextAction: "advance" }));
    expect(d1).toMatchObject({ progress: at("s2", 1), replySuffix: null });

    // Warm-up (position 2) is last, so nothing comes after it even though Short Talk was skipped.
    const d2 = decide(planTurn(l, d1.progress)!, out({ nextAction: "advance" }));
    expect(d2).toMatchObject({ nextAction: "end", lessonCompleted: true, progress: { sectionId: null } });

    const d3 = decide(planTurn(l, at("s1"))!, out({ nextAction: "follow_up" }));
    expect(d3.progress).toEqual(at("s1", 0, { followUps: 1 }));
    const d4 = decide(planTurn(l, at("s1", 0, { followUps: MAX_FOLLOW_UPS }))!, out({}));
    expect(d4).toMatchObject({ progress: at("s2"), replySuffix: "Let's move on to Warm-up. How was your week?" });
  });

  it("treats Chinese help as a detour that keeps the question and costs no follow-up", () => {
    const l = sample();
    const p = at("s2", 0, { followUps: 1 });
    const d = decide(
      planTurn(l, p)!,
      out({ intent: "chinese_assistance", nextAction: "follow_up", assistance: { english: "I stayed home." } }),
    );
    expect(d).toMatchObject({ nextAction: "repeat_or_skip", lessonCompleted: false });
    expect(d.progress).toEqual(at("s2", 0, { followUps: 1, pendingAssistance: "I stayed home." }));

    // Even with no follow-ups left, help is still allowed instead of a forced advance.
    const full = decide(
      planTurn(l, at("s2", 0, { followUps: MAX_FOLLOW_UPS }))!,
      out({ intent: "chinese_assistance", nextAction: "repeat_or_skip", assistance: { english: "x" } }),
    );
    expect(full.progress.sectionId).toBe("s2");
    expect(full.progress.questionIndex).toBe(0);

    const back = decide(planTurn(l, d.progress)!, out({ nextAction: "follow_up" }));
    expect(back.progress.pendingAssistance).toBeNull();
  });

  it("keeps the position when asking to confirm a suspected mishearing", () => {
    const p = at("s2", 0, { followUps: 1, pendingAssistance: "I stayed home." });
    expect(decide(planTurn(sample(), p)!, out({ nextAction: "confirm_transcript" })).progress).toEqual(p);
  });

  it("only ends early when the student asks to", () => {
    const l = sample();
    const premature = decide(planTurn(l, at("s2"))!, out({ nextAction: "end" }));
    expect(premature).toMatchObject({ nextAction: "advance", lessonCompleted: false, progress: at("s2", 1) });

    const asked = decide(planTurn(l, at("s2"))!, out({ intent: "request_end", nextAction: "follow_up" }));
    expect(asked).toMatchObject({ nextAction: "end", lessonCompleted: true });
  });

  it("uses a fixed question budget for sections without extracted prompts", () => {
    const l = lesson([section(0, "warm-up", "Warm-up"), section(1, "vocabulary", "Vocabulary")]);
    let p = at("s0");
    for (let i = 1; i < FALLBACK_QUESTIONS_PER_SECTION; i++) {
      p = decide(planTurn(l, p)!, out({ nextAction: "advance" })).progress;
      expect(p).toEqual(at("s0", i));
    }
    const d = decide(planTurn(l, p)!, out({ nextAction: "advance" }));
    expect(d.progress).toEqual(at("s1"));
    expect(planTurn(l, at("s1"))!.current.question).toBeNull();
  });

  it("continues after a section that went stale or lost prompts in a re-sync", () => {
    const l = lesson([
      section(1, "warm-up", "Warm-up", ["Q1"], true),
      section(2, "short-talk", "Short Talk", ["Q2"]),
      section(3, "conversation", "Conversation", ["Q3"]),
    ]);
    expect(currentStep(l, at("s1"))?.section.id).toBe("s2");
    expect(currentStep(l, at("s2", 5))?.section.id).toBe("s3");
    expect(currentStep(l, at("gone"))?.section.id).toBe("s2");

    const plan = planTurn(l, at("s1", 0, { followUps: MAX_FOLLOW_UPS, pendingAssistance: "x" }))!;
    expect(plan).toMatchObject({ followUps: 0, mustAdvance: false, pendingAssistance: null });
  });
});

describe("filterCorrections", () => {
  const c = (severity: "blocking" | "minor", original: string) => ({
    type: "grammar" as const,
    original,
    suggestion: `${original}!`,
    severity,
  });
  const all = [c("minor", "a"), c("blocking", "b"), c("blocking", "c")];

  it("corrects at most one blocking error now and defers the rest", () => {
    const result = filterCorrections(all, { verifiedByStudent: true, intent: "answer", nextAction: "correct" });
    expect(result.map((r) => [r.original, r.deferred])).toEqual([
      ["a", true],
      ["b", false],
      ["c", true],
    ]);
  });

  it("never grades unverified transcripts or suspected mishearings", () => {
    expect(filterCorrections(all, { verifiedByStudent: false, intent: "answer", nextAction: "correct" })).toEqual([]);
    expect(filterCorrections(all, { verifiedByStudent: true, intent: "answer", nextAction: "confirm_transcript" })).toEqual([]);
  });

  it("does not interrupt a Chinese-help turn with corrections", () => {
    const result = filterCorrections(all, { verifiedByStudent: true, intent: "chinese_assistance", nextAction: "repeat_or_skip" });
    expect(result.every((r) => r.deferred)).toBe(true);
  });
});

describe("composeReply", () => {
  const base = { intent: "answer" as const, nextAction: "follow_up" as const, corrections: [] };
  const decision = (o: Partial<Decision>): Decision => ({
    progress: at("s2"),
    nextAction: "follow_up",
    replySuffix: null,
    nextQuestion: null,
    lessonCompleted: false,
    ...o,
  });
  const forced = decision({ nextAction: "advance", replySuffix: "Next question: What did you eat?", nextQuestion: "What did you eat?" });

  it("keeps the model's reply when the controller agreed", () => {
    expect(composeReply({ ...base, teacherReply: "Nice! Why?" }, decision({}))).toBe("Nice! Why?");
  });

  it("replaces the model's own question when forcing an advance", () => {
    expect(composeReply({ ...base, teacherReply: "Good job. What else did you do?" }, forced)).toBe(
      "Good job. Next question: What did you eat?",
    );
    expect(composeReply({ ...base, teacherReply: "Why?" }, forced)).toBe("Next question: What did you eat?");
  });

  it("does not ask the next question twice", () => {
    expect(composeReply({ ...base, teacherReply: "OK! What did you eat?" }, forced)).toBe("OK! What did you eat?");
  });

  it("always offers a Chinese-help sentence with an invitation to repeat it", () => {
    const help = { ...base, intent: "chinese_assistance" as const, assistance: { english: "I stayed home." } };
    const d = decision({ nextAction: "repeat_or_skip" });
    for (const teacherReply of ["Let's move on. What is next?", "I stayed home. Did you rest?"]) {
      expect(composeReply({ ...help, teacherReply }, d)).toBe("You can say: I stayed home. Can you try saying that?");
    }
    const word = { ...help, assistance: { english: "destination" } };
    expect(composeReply({ ...word, teacherReply: "Hmm, let me think." }, d)).toBe("It's destination. Can you use it in a sentence?");
  });

  it("asks the next question when the model only announces the move", () => {
    const moved = decision({ nextAction: "advance", nextQuestion: "What did you do last weekend?" });
    expect(composeReply({ ...base, teacherReply: "Great! Let's talk about last weekend." }, moved)).toBe(
      "Great! Let's talk about last weekend. What did you do last weekend?",
    );
    expect(composeReply({ ...base, teacherReply: "Great! Where did you go last weekend?" }, moved)).toBe(
      "Great! Where did you go last weekend?",
    );
  });
});

describe("reply length", () => {
  it("keeps at most two statements and the last question", () => {
    expect(concise("Yes! A stopover is a short stay. For example, Tokyo. Now, another word. What is a suitcase?")).toBe(
      "Yes! A stopover is a short stay. What is a suitcase?",
    );
    expect(concise("Good. Why?")).toBe("Good. Why?");
  });

  it("opens with a greeting and only the lesson question", () => {
    expect(openingReply("Hello! How are you today? Let's start. Anything new?", "How was your week?")).toBe(
      "Hello! Let's start. How was your week?",
    );
  });

  it("answers a word request with the word", () => {
    const d: Decision = { progress: at("s2"), nextAction: "repeat_or_skip", replySuffix: null, nextQuestion: null, lessonCompleted: false };
    const out = {
      teacherReply: "It's destination. Can you say it in a sentence?",
      intent: "chinese_assistance" as const,
      nextAction: "repeat_or_skip" as const,
      corrections: [],
      assistance: { english: "destination" },
    };
    expect(composeReply(out, d)).toBe("It's destination. Can you say it in a sentence?");
  });
});

describe("wordRequest", () => {
  it("finds the word a student asks for", () => {
    expect(wordRequest("目的地的英文怎麼說？")).toBe("目的地");
    expect(wordRequest("請問 登機證英文是什麼")).toBe("登機證");
    expect(wordRequest("行李箱的英文要怎麼說")).toBe("行李箱");
    expect(wordRequest("用英文怎麼說「轉機」？")).toBe("轉機");
  });

  it("ignores ordinary Chinese answers", () => {
    expect(wordRequest("她現在好多了，已經回學校上課了")).toBeNull();
    expect(wordRequest("我想說我們在山上看到日出")).toBeNull();
  });
});

describe("newCorrections", () => {
  it("drops corrections that overlap ones already recorded or earlier in the same reply", () => {
    const c = (original: string) => ({ original });
    expect(
      newCorrections([c("I go to work every day"), c("my friend have"), c("my friend have a cold"), c("we go")], ["I go to work"]),
    ).toEqual([c("my friend have"), c("we go")]);
  });
});

describe("reconcile", () => {
  const shortTalk = () =>
    lesson([
      section(1, "short-talk", "Short Talk", [
        "How many times have you traveled by airplane?",
        "Have you ever been to a foreign country by yourself?",
        "Do you like shopping in duty-free shops? If so, why?",
        "Why do you prefer buying items in duty-free shops compared to regular stores?",
      ]),
    ]);
  const decided = (questionIndex: number, nextAction: Decision["nextAction"]): Decision => ({
    progress: at("s1", questionIndex, { followUps: 1 }),
    nextAction,
    replySuffix: null,
    nextQuestion: null,
    lessonCompleted: false,
  });

  it("follows the model to a later question the student had not answered yet", () => {
    // The student answered Q2 early; the model asks Q3 but calls it a follow-up on Q1.
    const r = reconcile(shortTalk(), decided(0, "follow_up"), "Great, you always travel with family. Do you like shopping in duty-free shops?");
    expect(r).toMatchObject({ nextAction: "advance", progress: at("s1", 2) });

    // Advanced to Q2 but the model skipped it because it was already answered.
    expect(reconcile(shortTalk(), decided(1, "advance"), "Nice! Do you like shopping in duty-free shops?").progress).toEqual(at("s1", 2));
  });

  it("stays put for follow-ups, rephrased current questions, help turns and backward moves", () => {
    const l = shortTalk();
    expect(reconcile(l, decided(0, "follow_up"), "Wow! Which trip was your favorite?").progress).toEqual(at("s1", 0, { followUps: 1 }));
    expect(reconcile(l, decided(1, "hint"), "Think again: have you traveled to another country alone?").progress.questionIndex).toBe(1);
    expect(reconcile(l, decided(0, "repeat_or_skip"), "Do you like shopping in duty-free shops?").progress.questionIndex).toBe(0);
    expect(reconcile(l, decided(2, "follow_up"), "Have you ever been to a foreign country by yourself?").progress.questionIndex).toBe(2);
  });

  it("matches rephrased questions but not loosely related ones", () => {
    expect(questionSimilarity("Do you like shopping in duty-free shops?", "Do you like shopping in duty-free shops? If so, why?")).toBe(1);
    expect(questionSimilarity("Do you often have stopovers when you travel?", "What do you call a short stay in a place between parts of a journey?")).toBe(0);
  });
});
