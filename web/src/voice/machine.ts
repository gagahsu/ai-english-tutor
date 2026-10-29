import type { SttLanguage } from "../api";

// Voice interaction state machine (SRS §5):
//   IDLE → TEACHER_SPEAKING → WAITING_FOR_STUDENT → LISTENING → TRANSCRIPT_REVIEW → THINKING → TEACHER_SPEAKING
// Every exception state still allows typing and retrying, and none of them drops the student's
// draft, so a failure never loses what was said (FR-04, NFR-03, AT-09–AT-11).

export type VoiceStatus =
  | "IDLE"
  | "TEACHER_SPEAKING"
  | "WAITING_FOR_STUDENT"
  | "LISTENING"
  | "TRANSCRIPT_REVIEW"
  | "THINKING"
  | "MIC_DENIED"
  | "STT_UNSUPPORTED"
  | "STT_NO_MATCH"
  | "NETWORK_ERROR"
  | "LLM_RATE_LIMIT"
  | "TTS_UNAVAILABLE";

export interface PendingAnswer {
  /** Reused when the same text is resent after an error, so the server answers it only once. */
  requestId: string;
  text: string;
  language: SttLanguage;
}

export interface VoiceState {
  status: VoiceStatus;
  /** The answer being reviewed or typed. */
  draft: string;
  /** "speech" while the draft is (edited) recognition output, "typed" for keyboard input. */
  draftSource: "speech" | "typed" | null;
  /** Live, not-yet-final recognition text while listening. */
  interim: string;
  /** The answer in flight, or the last one that failed. */
  pending: PendingAnswer | null;
  /** zh-TW explanation for the current exception state. */
  error: string | null;
  /** False once the browser or the student ruled out speech input; the lesson continues by text. */
  sttAvailable: boolean;
}

export type VoiceEvent =
  | { type: "LESSON_STARTED"; speak: boolean }
  | { type: "LESSON_ENDED" }
  | { type: "REPLAY" }
  | { type: "TTS_ENDED" }
  | { type: "TTS_FAILED"; message: string }
  | { type: "STOP_SPEAKING" }
  | { type: "LISTEN" }
  | { type: "STT_INTERIM"; text: string }
  | { type: "STT_FINAL"; text: string }
  | { type: "STT_ENDED" }
  | { type: "STT_ERROR"; code: string }
  | { type: "STT_UNSUPPORTED" }
  | { type: "EDIT"; text: string }
  | { type: "SUBMIT"; requestId: string; language: SttLanguage }
  | { type: "SUBMIT_OK"; speak: boolean }
  | { type: "SUBMIT_FAILED"; code: string; message: string };

export const initialVoiceState = (sttAvailable: boolean): VoiceState => ({
  status: sttAvailable ? "IDLE" : "STT_UNSUPPORTED",
  draft: "",
  draftSource: null,
  interim: "",
  pending: null,
  error: sttAvailable ? null : STT_UNSUPPORTED_MESSAGE,
  sttAvailable,
});

const STT_UNSUPPORTED_MESSAGE = "這個瀏覽器不支援語音辨識，請用打字回答（建議使用 Chrome 或 Edge 才能語音作答）。";

const LISTENABLE = new Set<VoiceStatus>([
  "WAITING_FOR_STUDENT",
  "TRANSCRIPT_REVIEW",
  "STT_NO_MATCH",
  "NETWORK_ERROR",
  "LLM_RATE_LIMIT",
  "TTS_UNAVAILABLE",
]);

/** Recording is never allowed while the teacher speaks (no echo) or while waiting for the reply. */
export const canListen = (s: VoiceState) => s.sttAvailable && LISTENABLE.has(s.status);

/** Typing is always possible except while recording or waiting for the teacher. */
export const canType = (s: VoiceState) => s.status !== "LISTENING" && s.status !== "THINKING" && s.status !== "IDLE";

export const canSubmit = (s: VoiceState) => canType(s) && s.draft.trim().length > 0;

/** After the teacher stops talking: back to the draft if the student typed one, else wait. */
const afterTeacher = (s: VoiceState): VoiceState => ({
  ...s,
  status: s.draft.trim() ? "TRANSCRIPT_REVIEW" : "WAITING_FOR_STUDENT",
  error: null,
});

const fail = (s: VoiceState, status: VoiceStatus, error: string, extra: Partial<VoiceState> = {}): VoiceState => ({
  ...s,
  status,
  error,
  interim: "",
  ...extra,
});

export function voiceReducer(s: VoiceState, e: VoiceEvent): VoiceState {
  switch (e.type) {
    case "LESSON_STARTED":
      return e.speak ? { ...s, status: "TEACHER_SPEAKING", error: null } : afterTeacher(s);
    case "LESSON_ENDED":
      return { ...s, status: "IDLE", interim: "", error: null };

    case "REPLAY":
      if (s.status === "LISTENING" || s.status === "THINKING" || s.status === "IDLE") return s;
      return { ...s, status: "TEACHER_SPEAKING", error: null };
    case "TTS_ENDED":
    case "STOP_SPEAKING":
      return s.status === "TEACHER_SPEAKING" ? afterTeacher(s) : s;
    case "TTS_FAILED":
      // The text is on screen; the lesson goes on without audio (AT-11).
      return s.status === "TEACHER_SPEAKING" || s.status === "WAITING_FOR_STUDENT"
        ? fail(s, "TTS_UNAVAILABLE", e.message)
        : s;

    case "LISTEN":
      if (!canListen(s)) return s;
      return { ...s, status: "LISTENING", draft: "", draftSource: "speech", interim: "", error: null };
    case "STT_INTERIM":
      return s.status === "LISTENING" ? { ...s, interim: e.text } : s;
    case "STT_FINAL":
      return s.status === "LISTENING" ? { ...s, draft: e.text, interim: "" } : s;
    case "STT_ENDED":
      if (s.status !== "LISTENING") return s;
      return s.draft.trim()
        ? { ...s, status: "TRANSCRIPT_REVIEW", interim: "", error: null }
        : fail(s, "STT_NO_MATCH", "沒有聽到聲音或辨識不出來，請再錄一次，或直接打字回答。");
    case "STT_ERROR":
      return sttError(s, e.code);
    case "STT_UNSUPPORTED":
      return fail(s, "STT_UNSUPPORTED", STT_UNSUPPORTED_MESSAGE, { sttAvailable: false });

    case "EDIT": {
      if (!canType(s)) return s;
      const draftSource = s.draftSource === "speech" && s.draft ? "speech" : e.text ? "typed" : null;
      if (s.status === "TEACHER_SPEAKING") return { ...s, draft: e.text, draftSource };
      // Typing keeps an exception's message visible only until there is something to send.
      if (!e.text.trim()) return { ...s, draft: e.text, draftSource };
      return { ...s, status: "TRANSCRIPT_REVIEW", draft: e.text, draftSource, error: null };
    }
    case "SUBMIT": {
      if (!canSubmit(s)) return s;
      const text = s.draft.trim();
      const retry = s.pending && s.pending.text === text && s.pending.language === e.language;
      const pending = retry ? s.pending! : { requestId: e.requestId, text, language: e.language };
      return { ...s, status: "THINKING", pending, error: null };
    }
    case "SUBMIT_OK":
      return {
        ...s,
        status: e.speak ? "TEACHER_SPEAKING" : "WAITING_FOR_STUDENT",
        draft: "",
        draftSource: null,
        pending: null,
        error: null,
      };
    case "SUBMIT_FAILED":
      // The draft and its requestId stay, so the same answer can be resent as is (AT-10).
      if (s.status !== "THINKING") return s;
      return fail(s, e.code === "LLM_RATE_LIMIT" ? "LLM_RATE_LIMIT" : "NETWORK_ERROR", e.message);
  }
}

function sttError(s: VoiceState, code: string): VoiceState {
  if (s.status !== "LISTENING") return s;
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return fail(s, "MIC_DENIED", "麥克風權限被拒絕，請在網址列左側允許麥克風，或直接打字回答。", { sttAvailable: false });
    case "audio-capture":
      return fail(s, "MIC_DENIED", "找不到可用的麥克風，請檢查裝置，或直接打字回答。");
    case "network":
      return fail(s, "NETWORK_ERROR", "語音辨識服務連不上（瀏覽器的辨識需要網路），請再試一次或打字回答。");
    case "language-not-supported":
      return fail(s, "STT_UNSUPPORTED", "這個瀏覽器不支援目前選的辨識語言，請切換語言或打字回答。");
    case "no-speech":
      return fail(s, "STT_NO_MATCH", "沒有聽到聲音，請靠近麥克風再錄一次，或直接打字回答。");
    case "aborted":
      // We cancelled it ourselves (e.g. the student stopped early with nothing said).
      return s.draft.trim() ? { ...s, status: "TRANSCRIPT_REVIEW", interim: "" } : afterTeacher({ ...s, interim: "" });
    default:
      return fail(s, "STT_NO_MATCH", "語音辨識發生問題，請再錄一次，或直接打字回答。");
  }
}
