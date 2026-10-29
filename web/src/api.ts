// Typed client for the Node API. Shapes mirror server/src/*/views.ts (student-facing only).

export type SttLanguage = "en-US" | "zh-TW";

export interface Settings {
  correctionMode: "balanced";
  speechRate: number;
  teachingLanguage: "english";
  studentLevel: "A1" | "A2" | "B1" | "B2" | "C1" | "C2";
  locale: "zh-TW";
  sttLanguage: SttLanguage;
}

export interface LessonSummary {
  id: string;
  title: string;
  level: string | null;
  course: string | null;
  series: string | null;
  unit: number | null;
  totalUnits: number | null;
  stale: boolean;
  lastSyncedAt: string;
}

export interface Resource {
  kind: string;
  name?: string;
  url?: string;
}

export interface LessonSection {
  id: string;
  kind: string;
  title: string;
  prompts: string[];
  vocabulary: { term: string; meaningZh?: string }[];
  resources: Resource[];
  extractionStatus: "pending" | "done" | "failed" | "needs_review";
}

export interface Lesson extends LessonSummary {
  sections: LessonSection[];
}

export interface Assistance {
  english: string;
  zhExplanation?: string;
}

export interface Correction {
  type: string;
  original: string;
  suggestion: string;
  reasonZh: string | null;
}

export interface TeacherTurn {
  id: string;
  role: "teacher";
  text: string;
  lessonSectionId: string | null;
  intent: string | null;
  nextAction: string | null;
  assistance: Assistance | null;
  degraded: boolean;
  createdAt: string;
}

export interface StudentTurn {
  id: string;
  role: "student";
  text: string;
  requestId: string | null;
  inputLanguage: string | null;
  verifiedByStudent: boolean | null;
  corrections: Correction[];
  createdAt: string;
}

export type Turn = TeacherTurn | StudentTurn;

export interface SessionProgress {
  id: string;
  state: "active" | "completed" | "finished";
  sectionId: string | null;
  sectionTitle: string | null;
  questionIndex: number;
}

export interface Session extends SessionProgress {
  lessonId: string;
  lessonTitle: string;
  settings: Settings;
  startedAt: string;
  endedAt: string | null;
  turns: Turn[];
}

export interface Exchange {
  student: StudentTurn;
  teacher: TeacherTurn;
  session: SessionProgress;
}

export interface SyncResult {
  lessons: { id: string; title: string; status: string }[];
  warnings: { lessonTitle?: string; message: string }[];
}

export interface ServiceStatus {
  configured: boolean;
  ok?: boolean;
  model?: string;
  databaseTitle?: string;
  error?: { code: string; message: string };
}

/** An error whose zh-TW message can be shown to the student as is. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

const TURN_TIMEOUT_MS = 60_000;

async function request<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiError("TIMEOUT", "老師回覆逾時，請重新送出；你的回答還在。");
    }
    throw new ApiError("NETWORK_ERROR", "無法連線到伺服器，請確認網站後端有在執行後再試。");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const error = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(error?.code ?? "HTTP_ERROR", error?.message ?? `伺服器錯誤（${res.status}）`, res.status);
  }
  return data as T;
}

export const api = {
  notionStatus: () => request<ServiceStatus>("GET", "/api/notion/status"),
  llmStatus: () => request<ServiceStatus>("GET", "/api/llm/status"),
  listLessons: () => request<{ lessons: LessonSummary[] }>("GET", "/api/lessons").then((r) => r.lessons),
  getLesson: (id: string) => request<Lesson>("GET", `/api/lessons/${encodeURIComponent(id)}`),
  syncLessons: () => request<SyncResult>("POST", "/api/lessons/sync"),
  extractLesson: (id: string) => request<unknown>("POST", `/api/lessons/${encodeURIComponent(id)}/extract`, {}),
  getSettings: () => request<Settings>("GET", "/api/settings"),
  updateSettings: (patch: Partial<Settings>) => request<Settings>("PUT", "/api/settings", patch),
  startSession: (lessonId: string, sectionId?: string) => request<Session>("POST", "/api/sessions", { lessonId, sectionId }),
  getSession: (id: string) => request<Session>("GET", `/api/sessions/${encodeURIComponent(id)}`),
  submitTurn: (
    sessionId: string,
    turn: { requestId: string; text: string; inputLanguage: SttLanguage; verifiedByStudent: boolean },
  ) => request<Exchange>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/turns`, turn, TURN_TIMEOUT_MS),
};
