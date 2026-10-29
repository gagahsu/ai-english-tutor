import type { Db } from "../db.js";
import { AppError, llmNotConfigured } from "../errors.js";
import { getLesson } from "../lessons/repository.js";
import type { Lesson } from "../lessons/types.js";
import type { ChatMessage, LlmProvider } from "../llm/provider.js";
import { completeStructured } from "../llm/structured.js";
import { getSettings, type Settings } from "../settings.js";
import {
  decide,
  filterCorrections,
  holdPosition,
  initialProgress,
  planTurn,
  reconcile,
  type Decision,
  type TurnPlan,
} from "./controller.js";
import { buildTeacherMessages, hasChinese, wordRequest } from "./prompt.js";
import {
  createSession,
  findExchange,
  getSession,
  listFeedback,
  listTurns,
  saveExchange,
  type NewStudentTurn,
  type NewTeacherTurn,
} from "./repository.js";
import { teacherOutputSchema, type TeacherOutput, type TurnInput } from "./types.js";
import { toProgressView, toSessionView, toTurnView } from "./views.js";

const TURN_REQUEST = { maxTokens: 800, temperature: 0.5 };

export async function startSession(
  db: Db,
  llm: LlmProvider | null,
  input: { lessonId: string; sectionId?: string },
  now = () => new Date(),
) {
  const lesson = getLesson(db, input.lessonId);
  if (!lesson) throw new AppError(404, "LESSON_NOT_FOUND", "找不到這堂課。");
  const progress = initialProgress(lesson, input.sectionId);
  if (!progress) {
    throw input.sectionId
      ? new AppError(404, "SECTION_NOT_FOUND", "找不到這個章節。")
      : new AppError(409, "LESSON_NOT_TEACHABLE", "這堂課沒有可以上課的章節，請先從 Notion 重新同步。");
  }
  const settings = getSettings(db);
  const plan = planTurn(lesson, progress)!;
  const opening = await openingTurn(llm, lesson, plan, settings);
  const id = createSession(db, { lessonId: lesson.id, progress, settings, opening, now: now().toISOString() });
  return sessionView(db, id);
}

/** The teacher speaks first (FR-03). Without a working LLM the lesson still opens with a fixed line. */
async function openingTurn(llm: LlmProvider | null, lesson: Lesson, plan: TurnPlan, settings: Settings): Promise<NewTeacherTurn> {
  const sectionId = plan.current.section.id;
  if (llm) {
    try {
      const result = await completeStructured(
        llm,
        { messages: buildTeacherMessages({ lesson, plan, settings, history: [] }), ...TURN_REQUEST, purpose: "open" },
        teacherOutputSchema,
      );
      if (result.ok) return { sectionId, text: speakable(openingReply(result.value.teacherReply, plan.current.question)), meta: { intent: null, nextAction: "follow_up" } };
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
    }
  }
  const question = plan.current.question ?? "Are you ready to begin?";
  return {
    sectionId,
    text: `Hi! Let's start with ${plan.current.section.title}. ${question}`,
    meta: { intent: null, nextAction: "follow_up", degraded: true },
  };
}

const busy = new Set<string>();

/**
 * One student answer → one teacher reply. Nothing is saved unless the whole exchange
 * succeeds, so after an LLM error the student can resend the same answer (AT-10).
 */
export async function submitTurn(db: Db, llm: LlmProvider | null, sessionId: string, input: TurnInput, now = () => new Date()) {
  const session = getSession(db, sessionId);
  if (!session) throw sessionNotFound();
  const replay = findExchange(db, sessionId, input.requestId);
  if (replay) return exchangeView(db, sessionId, replay);
  if (session.state !== "active") throw new AppError(409, "SESSION_NOT_ACTIVE", "這堂課已經結束，無法再提交回答。");
  if (!llm) throw llmNotConfigured();
  if (busy.has(sessionId)) throw new AppError(409, "TURN_IN_PROGRESS", "老師還在回覆上一個回答，請稍候。");

  busy.add(sessionId);
  try {
    const lesson = getLesson(db, session.lessonId)!;
    const plan = planTurn(lesson, session.progress);
    if (!plan) throw new AppError(409, "SESSION_NOT_ACTIVE", "這堂課已經沒有下一題了。");

    const messages = buildTeacherMessages({ lesson, plan, settings: session.settings, history: listTurns(db, sessionId), student: input });
    let result = await completeStructured(llm, { messages, ...TURN_REQUEST, purpose: "turn" }, teacherOutputSchema);
    if (result.ok && missedChineseHelp(input.text, result.value)) {
      const recheck = await completeStructured(
        llm,
        { messages: [...messages, ...chineseHelpReminder(input.text, result.value)], ...TURN_REQUEST, purpose: "turn-recheck" },
        teacherOutputSchema,
      );
      if (recheck.ok) result = recheck;
    }

    const student: NewStudentTurn = {
      sectionId: plan.current.section.id,
      requestId: input.requestId,
      inputLanguage: input.inputLanguage,
      transcript: input.text,
      verifiedByStudent: input.verifiedByStudent,
      corrections: [],
    };
    let teacher: NewTeacherTurn;
    let progress = holdPosition(plan);
    let completed = false;

    if (result.ok) {
      const out = result.value;
      const proposed = decide(plan, out);
      const text = speakable(composeReply(out, proposed));
      // Track the question the student actually heard, which may be later than planned.
      const decision = reconcile(lesson, proposed, text);
      progress = decision.progress;
      completed = decision.lessonCompleted;
      student.corrections = filterCorrections(
        newCorrections(out.corrections, listFeedback(db, sessionId).map((f) => f.original)).filter(
          // Repeating the offered sentence in other correct words is not an error.
          (c) => !plan.pendingAssistance || normalized(c.suggestion) !== normalized(plan.pendingAssistance),
        ),
        { verifiedByStudent: input.verifiedByStudent, intent: out.intent, nextAction: decision.nextAction },
      );
      teacher = {
        sectionId: progress.sectionId ?? plan.current.section.id,
        text,
        meta: { intent: out.intent, nextAction: decision.nextAction, assistance: out.assistance },
      };
    } else {
      // Unusable output twice: keep the lesson where it is and ask again (SRS §8).
      teacher = {
        sectionId: plan.current.section.id,
        text: degradedReply(result.raw, plan),
        meta: { intent: null, nextAction: "follow_up", degraded: true },
      };
    }

    saveExchange(db, { sessionId, student, teacher, progress, state: completed ? "completed" : "active", now: now().toISOString() });
  } finally {
    busy.delete(sessionId);
  }
  return exchangeView(db, sessionId, findExchange(db, sessionId, input.requestId)!);
}

/**
 * Code-switching must get an English model sentence (SRS §4.4, AT-05), but small models often
 * grade a mixed answer as plain English. Requests ("跳過", "再說一次") are left alone.
 */
/**
 * The model repeats earlier corrections and reports one error at two lengths ("I go to work" and
 * "I go to work every day"); keep a correction only if its text overlaps nothing already recorded.
 */
export function newCorrections<C extends { original: string }>(corrections: C[], recorded: string[]): C[] {
  const seen = recorded.map(normalized);
  return corrections.filter((c) => {
    const text = normalized(c.original);
    if (!text || seen.some((s) => s.includes(text) || text.includes(s))) return false;
    seen.push(text);
    return true;
  });
}

function missedChineseHelp(text: string, out: TeacherOutput): boolean {
  if (!hasChinese(text)) return false;
  // English help that still contains Chinese, or a whole sentence where one word was asked for, is wrong.
  const english = out.assistance?.english;
  if (english && hasChinese(english)) return true;
  if (wordRequest(text)) return !english || english.split(/\s+/).length > 6;
  return (out.intent === "answer" || out.intent === "other") && !out.assistance;
}

function chineseHelpReminder(text: string, out: TeacherOutput): ChatMessage[] {
  const asked = wordRequest(text);
  const words = [...new Set(text.match(/[\p{Script=Han}]+/gu))].map((w) => `「${w}」`).join("");
  return [
    { role: "assistant", content: JSON.stringify(out) },
    {
      role: "user",
      content: asked
        ? `Wrong: the student wants the English word for 「${asked}」. Reply "It's <English word>." and ask them to use it in a sentence; put only that English word in assistance.english, with intent "chinese_assistance" and nextAction "repeat_or_skip". Reply again with only the JSON object.`
        : `The student used Chinese (${words}), so this needs Chinese help: give one full English sentence for everything they meant in assistance.english (English only), with intent "chinese_assistance" and nextAction "repeat_or_skip". Reply again with only the JSON object.`,
    },
  ];
}

/**
 * Makes the spoken reply match what the controller decided. When it overrode the model, the
 * model's own question is dropped so the student still hears exactly one question.
 */
export function composeReply(out: TeacherOutput, decision: Decision): string {
  const english = out.assistance?.english;
  if (decision.nextAction === "repeat_or_skip" && english) {
    // A model sentence always comes with the invitation to repeat it (SRS §4.4); a single word the
    // student asked for keeps the model's wording when it contains the word.
    if (isSentence(english)) return `You can say: ${english} Can you try saying that?`;
    if (normalized(out.teacherReply).includes(normalized(english))) return concise(out.teacherReply);
    return `It's ${english}. Can you use it in a sentence?`;
  }
  return composeLesson({ ...out, teacherReply: concise(out.teacherReply) }, decision);
}

const isSentence = (english: string) => /[.!?]$/.test(english.trim()) || english.trim().split(/\s+/).length > 4;

function composeLesson(out: TeacherOutput, decision: Decision): string {
  const suffix = decision.replySuffix;
  if (!suffix) {
    // Moving on must actually ask the next question, not just announce it.
    const next = decision.nextAction === "advance" ? decision.nextQuestion : null;
    return next && !sentences(out.teacherReply).some(isQuestion) ? `${out.teacherReply} ${next}` : out.teacherReply;
  }
  const question = decision.nextQuestion;
  if (question && normalized(out.teacherReply).includes(normalized(question))) return out.teacherReply;
  return replaceQuestions(out.teacherReply, suffix);
}

/** The opening asks the lesson's first question (AT-02) and nothing else, e.g. no "How are you?". */
export function openingReply(reply: string, question: string | null): string {
  return question ? replaceQuestions(reply, question) : concise(reply);
}

const sentences = (text: string) => text.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
const isQuestion = (sentence: string) => sentence.trim().endsWith("?");
const MAX_STATEMENTS = 2;

/** Drops the reply's own questions and ends with `ask`, so the student hears one question. */
function replaceQuestions(reply: string, ask: string): string {
  const statements = sentences(reply).filter((s) => !isQuestion(s)).slice(0, MAX_STATEMENTS);
  return [...statements, ask].join(" ");
}

/** Keeps a reply to about three sentences (SRS §4.2), ending with its last question. */
export function concise(reply: string): string {
  const all = sentences(reply);
  const questions = all.filter(isQuestion).length;
  // One core question per turn (SRS §4.2): "Did you like it? What was it about?" keeps the last.
  if (all.length <= MAX_STATEMENTS + 1 && questions <= 1) return reply.trim();
  const question = all.findLast(isQuestion);
  return question ? replaceQuestions(reply, question) : all.slice(0, MAX_STATEMENTS + 1).join(" ");
}

const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Replies are read by TTS; drop Markdown emphasis the model adds despite instructions. */
const speakable = (text: string) => text.replace(/[*_`#]+/g, "").replace(/\s{2,}/g, " ").trim();

function degradedReply(raw: string, plan: TurnPlan): string {
  const prose = raw.trim();
  if (prose && prose.length <= 600 && !/^[{[`]/.test(prose)) return prose;
  return `Sorry, I didn't catch that. ${plan.current.question ?? "Could you say it again?"}`;
}

export function sessionView(db: Db, sessionId: string) {
  const session = getSession(db, sessionId);
  if (!session) throw sessionNotFound();
  const lesson = getLesson(db, session.lessonId)!;
  return toSessionView(session, lesson, listTurns(db, sessionId), listFeedback(db, sessionId));
}

function exchangeView(db: Db, sessionId: string, exchange: NonNullable<ReturnType<typeof findExchange>>) {
  const session = getSession(db, sessionId)!;
  const feedback = listFeedback(db, sessionId);
  return {
    student: toTurnView(exchange.student, feedback),
    teacher: toTurnView(exchange.teacher, feedback),
    session: toProgressView(session, getLesson(db, session.lessonId)!),
  };
}

const sessionNotFound = () => new AppError(404, "SESSION_NOT_FOUND", "找不到這堂課的上課紀錄。");
