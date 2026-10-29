import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { Settings } from "../settings.js";
import type {
  Correction,
  FeedbackRecord,
  Progress,
  Session,
  SessionState,
  SessionSummary,
  TeacherMeta,
  TurnRecord,
} from "./types.js";

interface SessionRowDb {
  id: string;
  lesson_id: string;
  state: string;
  progress: string;
  settings_snapshot: string;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
}

interface TurnRowDb {
  id: string;
  session_id: string;
  seq: number;
  role: string;
  section_id: string | null;
  request_id: string | null;
  in_reply_to: string | null;
  input_language: string | null;
  transcript: string | null;
  verified_by_student: number | null;
  teacher_text: string | null;
  meta: string | null;
  created_at: string;
}

interface FeedbackRowDb {
  id: string;
  turn_id: string;
  type: string;
  original: string;
  suggestion: string;
  reason_zh: string | null;
  deferred: number;
  review_status: string;
}

const toSession = (r: SessionRowDb): Session => ({
  id: r.id,
  lessonId: r.lesson_id,
  state: r.state as SessionState,
  progress: JSON.parse(r.progress),
  settings: JSON.parse(r.settings_snapshot),
  startedAt: r.started_at,
  endedAt: r.ended_at,
  summary: r.summary ? JSON.parse(r.summary) : null,
});

const toTurn = (r: TurnRowDb): TurnRecord => ({
  id: r.id,
  seq: r.seq,
  role: r.role as TurnRecord["role"],
  sectionId: r.section_id,
  requestId: r.request_id,
  inReplyTo: r.in_reply_to,
  inputLanguage: r.input_language,
  transcript: r.transcript,
  verifiedByStudent: r.verified_by_student === null ? null : r.verified_by_student === 1,
  teacherText: r.teacher_text,
  meta: r.meta ? JSON.parse(r.meta) : null,
  createdAt: r.created_at,
});

const toFeedback = (r: FeedbackRowDb): FeedbackRecord => ({
  id: r.id,
  turnId: r.turn_id,
  type: r.type,
  original: r.original,
  suggestion: r.suggestion,
  reasonZh: r.reason_zh,
  deferred: r.deferred === 1,
  reviewStatus: r.review_status,
});

export function getSession(db: Db, id: string): Session | null {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRowDb | undefined;
  return row ? toSession(row) : null;
}

export interface SessionListItem {
  session: Session;
  answers: number;
}

/** Newest first; optionally for one lesson. */
export function listSessions(db: Db, lessonId?: string): SessionListItem[] {
  const rows = db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id AND t.role = 'student') AS answers
       FROM sessions s ${lessonId ? "WHERE s.lesson_id = ?" : ""}
       ORDER BY s.started_at DESC, s.rowid DESC`,
    )
    .all(...(lessonId ? [lessonId] : [])) as (SessionRowDb & { answers: number })[];
  return rows.map((r) => ({ session: toSession(r), answers: r.answers }));
}

/** Stores the after-class summary and closes the session (FR-11). */
export function saveSummary(db: Db, sessionId: string, summary: SessionSummary, now: string): void {
  db.prepare(
    `UPDATE sessions SET summary = ?, state = 'finished', ended_at = COALESCE(ended_at, ?) WHERE id = ?`,
  ).run(JSON.stringify(summary), now, sessionId);
}

/** Deletes sessions with their turns and feedback (NFR-05). Returns how many were removed. */
export function deleteSessions(db: Db, sessionId?: string): number {
  return db.transaction(() => {
    const ids = sessionId
      ? [sessionId]
      : (db.prepare("SELECT id FROM sessions").all() as { id: string }[]).map((r) => r.id);
    let removed = 0;
    for (const id of ids) {
      // Teacher turns reference student turns (in_reply_to), so clear those links first.
      db.prepare("UPDATE turns SET in_reply_to = NULL WHERE session_id = ?").run(id);
      removed += db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes;
    }
    return removed;
  })();
}

export function listTurns(db: Db, sessionId: string): TurnRecord[] {
  return (db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY seq").all(sessionId) as TurnRowDb[]).map(toTurn);
}

export function listFeedback(db: Db, sessionId: string): FeedbackRecord[] {
  return (
    db
      .prepare(
        `SELECT f.* FROM feedback f JOIN turns t ON t.id = f.turn_id
         WHERE t.session_id = ? ORDER BY t.seq, f.rowid`,
      )
      .all(sessionId) as FeedbackRowDb[]
  ).map(toFeedback);
}

/** The stored exchange for a request id, so a resubmitted answer gets the same reply. */
export function findExchange(db: Db, sessionId: string, requestId: string): { student: TurnRecord; teacher: TurnRecord } | null {
  const student = db.prepare("SELECT * FROM turns WHERE session_id = ? AND request_id = ?").get(sessionId, requestId) as
    | TurnRowDb
    | undefined;
  if (!student) return null;
  const teacher = db.prepare("SELECT * FROM turns WHERE in_reply_to = ?").get(student.id) as TurnRowDb | undefined;
  return teacher ? { student: toTurn(student), teacher: toTurn(teacher) } : null;
}

export interface NewTeacherTurn {
  sectionId: string | null;
  text: string;
  meta: TeacherMeta;
}

export interface NewStudentTurn {
  sectionId: string | null;
  requestId: string;
  inputLanguage: string;
  transcript: string;
  verifiedByStudent: boolean;
  corrections: (Correction & { deferred: boolean })[];
}

export function createSession(
  db: Db,
  input: { lessonId: string; progress: Progress; settings: Settings; opening: NewTeacherTurn; now: string },
): string {
  const id = randomUUID();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions (id, lesson_id, state, progress, settings_snapshot, started_at)
       VALUES (?, ?, 'active', ?, ?, ?)`,
    ).run(id, input.lessonId, JSON.stringify(input.progress), JSON.stringify(input.settings), input.now);
    insertTeacherTurn(db, id, null, input.opening, input.now);
  })();
  return id;
}

/** Saves one exchange and the controller's new state atomically. */
export function saveExchange(
  db: Db,
  input: {
    sessionId: string;
    student: NewStudentTurn;
    teacher: NewTeacherTurn;
    progress: Progress;
    state: SessionState;
    now: string;
  },
): void {
  db.transaction(() => {
    const studentId = randomUUID();
    const s = input.student;
    db.prepare(
      `INSERT INTO turns (id, session_id, seq, role, section_id, request_id, input_language, transcript,
                          verified_by_student, created_at)
       VALUES (?, ?, ?, 'student', ?, ?, ?, ?, ?, ?)`,
    ).run(
      studentId,
      input.sessionId,
      nextSeq(db, input.sessionId),
      s.sectionId,
      s.requestId,
      s.inputLanguage,
      s.transcript,
      s.verifiedByStudent ? 1 : 0,
      input.now,
    );
    const insertFeedback = db.prepare(
      `INSERT INTO feedback (id, turn_id, type, original, suggestion, reason_zh, deferred)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of s.corrections) {
      insertFeedback.run(randomUUID(), studentId, c.type, c.original, c.suggestion, c.reasonZh ?? null, c.deferred ? 1 : 0);
    }
    insertTeacherTurn(db, input.sessionId, studentId, input.teacher, input.now);
    db.prepare("UPDATE sessions SET progress = ?, state = ?, ended_at = ? WHERE id = ?").run(
      JSON.stringify(input.progress),
      input.state,
      input.state === "active" ? null : input.now,
      input.sessionId,
    );
  })();
}

function insertTeacherTurn(db: Db, sessionId: string, inReplyTo: string | null, t: NewTeacherTurn, now: string): void {
  db.prepare(
    `INSERT INTO turns (id, session_id, seq, role, section_id, in_reply_to, teacher_text, meta, created_at)
     VALUES (?, ?, ?, 'teacher', ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), sessionId, nextSeq(db, sessionId), t.sectionId, inReplyTo, t.text, JSON.stringify(t.meta), now);
}

const nextSeq = (db: Db, sessionId: string) =>
  (db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM turns WHERE session_id = ?").get(sessionId) as { seq: number })
    .seq;
