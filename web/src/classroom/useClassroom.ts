import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ApiError, type Lesson, type Session, type SessionListItem, type Settings, type SttLanguage, type TeacherTurn } from "../api";
import { useDeps } from "../deps";
import { canListen, initialVoiceState, voiceReducer } from "../voice/machine";
import type { SttRecording } from "../voice/stt";
import { TtsError } from "../voice/tts";

export type Phase =
  | "loading"
  | "preparing"
  | "ready"
  | "starting"
  | "active"
  /** The teacher ran out of questions or the student asked to stop; the summary is being made. */
  | "completed"
  | "finishing"
  | "finished"
  | "error";

/** Sent when the student chooses not to repeat the offered sentence (SRS §4.4: repeating is skippable). */
export const SKIP_REPEAT_TEXT = "Skip repeating, please. Let's go back to the question.";

/**
 * Runs one lesson in the browser: loads and prepares it, starts the session, and drives the voice
 * state machine with the speech engines and the turn API. The server owns lesson progress; this
 * only mirrors what it returns.
 */
export function useClassroom(lessonId: string) {
  const { api, stt, tts } = useDeps();
  const [phase, setPhase] = useState<Phase>("loading");
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [history, setHistory] = useState<SessionListItem[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [speakingTurnId, setSpeakingTurnId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [voice, dispatch] = useReducer(voiceReducer, stt.supported, initialVoiceState);

  const recording = useRef<SttRecording | null>(null);
  // The language the current speech draft was recognised in, which may differ from the toggle.
  const draftLanguage = useRef<SttLanguage | null>(null);
  const speechToken = useRef(0);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const finishingRef = useRef(false);

  // Load the lesson, and run the one-time section extraction first if it has not happened yet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [loaded, loadedSettings, llm, past] = await Promise.all([
          api.getLesson(lessonId),
          api.getSettings(),
          api.llmStatus(),
          api.listSessions(lessonId).catch(() => []),
        ]);
        if (cancelled) return;
        setSettings(loadedSettings);
        setLesson(loaded);
        setHistory(past);
        const needsExtraction = loaded.sections.some((s) => s.extractionStatus === "pending" || s.extractionStatus === "failed");
        if (needsExtraction && llm.configured) {
          setPhase("preparing");
          try {
            await api.extractLesson(lessonId).catch(async (err: unknown) => {
              // Another tab (or React's dev double-mount) is already extracting: wait for it.
              if (!(err instanceof ApiError) || err.code !== "EXTRACTION_IN_PROGRESS") throw err;
              for (let waited = 0; waited < 90_000 && !cancelled; waited += 2_000) {
                await new Promise((r) => setTimeout(r, 2_000));
                const now = await api.getLesson(lessonId);
                if (!now.sections.some((s) => s.extractionStatus === "pending")) return;
              }
            });
            if (!cancelled) setLesson(await api.getLesson(lessonId));
          } catch (err) {
            if (!cancelled) {
              setNotice(`教材整理沒有完成（${err instanceof ApiError ? err.message : "未知錯誤"}），老師會直接依筆記上課。`);
            }
          }
        }
        if (!cancelled) setPhase("ready");
      } catch (err) {
        if (cancelled) return;
        setNotice(err instanceof ApiError ? err.message : "無法載入課程。");
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, lessonId]);

  // Never leave speech or the microphone running after leaving the page.
  useEffect(
    () => () => {
      tts.cancel();
      recording.current?.abort();
    },
    [tts],
  );

  const rate = settings?.speechRate ?? 1;
  const language: SttLanguage = settings?.sttLanguage ?? "en-US";

  /** Speaks a teacher line; the machine must already be in TEACHER_SPEAKING. */
  const speak = useCallback(
    (text: string, turnId: string | null) => {
      const token = ++speechToken.current;
      setSpeakingTurnId(turnId);
      setPaused(false);
      tts.speak(text, rate).then(
        () => {
          if (token !== speechToken.current) return;
          setSpeakingTurnId(null);
          dispatch({ type: "TTS_ENDED" });
        },
        (err: unknown) => {
          if (token !== speechToken.current) return;
          setSpeakingTurnId(null);
          dispatch({ type: "TTS_FAILED", message: err instanceof TtsError ? err.message : "語音朗讀失敗，老師的話會以文字顯示。" });
        },
      );
    },
    [tts, rate],
  );

  const silence = useCallback(() => {
    speechToken.current++;
    tts.cancel();
    setSpeakingTurnId(null);
    setPaused(false);
  }, [tts]);

  /** Enters a new or resumed session; the teacher (re)reads her last line, i.e. the open question. */
  const enter = useCallback(
    async (load: () => Promise<Session>, failure: string) => {
      setPhase("starting");
      setNotice(null);
      try {
        const loaded = await load();
        setSession(loaded);
        if (loaded.summary) {
          setPhase("finished");
          dispatch({ type: "LESSON_ENDED" });
          return;
        }
        setPhase(loaded.state === "active" ? "active" : "completed");
        const last = loaded.turns.findLast((t): t is TeacherTurn => t.role === "teacher");
        dispatch({ type: "LESSON_STARTED", speak: !!last && tts.supported });
        if (last && tts.supported) speak(last.text, last.id);
        else if (!tts.supported) dispatch({ type: "TTS_FAILED", message: "這個瀏覽器不支援語音朗讀，老師的話會以文字顯示。" });
      } catch (err) {
        setNotice(err instanceof ApiError ? err.message : failure);
        setPhase("ready");
      }
    },
    [speak, tts.supported],
  );

  const start = useCallback(
    (sectionId?: string) => enter(() => api.startSession(lessonId, sectionId), "無法開始上課。"),
    [api, enter, lessonId],
  );

  /** Continues an unfinished session where it stopped (FR-10). */
  const resume = useCallback((sessionId: string) => enter(() => api.getSession(sessionId), "無法載入上次的課。"), [api, enter]);

  /**
   * Ends the lesson and shows the after-class summary (FR-11). Called by the student, or
   * automatically once the lesson is complete; that one lets the teacher finish her goodbye.
   */
  const finish = useCallback(
    async ({ stopSpeech = true }: { stopSpeech?: boolean } = {}) => {
      const current = sessionRef.current;
      // A ref, not state: two calls in the same render (e.g. StrictMode effects) must not both run.
      if (!current || finishingRef.current) return;
      finishingRef.current = true;
      const before = phaseRef.current;
      if (stopSpeech) silence();
      recording.current?.abort();
      setPhase("finishing");
      try {
        const finished = await api.finishSession(current.id);
        setSession(finished);
        setPhase("finished");
        if (stopSpeech) dispatch({ type: "LESSON_ENDED" });
      } catch (err) {
        setNotice(`${err instanceof ApiError ? err.message : "無法產生課後摘要。"}可以稍後再按一次。`);
        setPhase(before === "finished" ? "finished" : before === "finishing" ? "completed" : before);
      } finally {
        finishingRef.current = false;
      }
    },
    [api, silence],
  );

  const replay = useCallback(
    (text: string, turnId: string | null) => {
      if (voiceRef.current.status === "LISTENING" || voiceRef.current.status === "THINKING") return;
      silence();
      dispatch({ type: "REPLAY" });
      speak(text, turnId);
    },
    [silence, speak],
  );

  const stopSpeaking = useCallback(() => {
    silence();
    dispatch({ type: "STOP_SPEAKING" });
  }, [silence]);

  const togglePause = useCallback(() => {
    if (paused) tts.resume();
    else tts.pause();
    setPaused(!paused);
  }, [paused, tts]);

  /** Starts recording; repeating an offered English sentence passes "en-US" whatever the toggle says. */
  const listen = useCallback(
    (lang: SttLanguage = language) => {
    if (!canListen(voiceRef.current)) return;
    dispatch({ type: "LISTEN" });
    setStopping(false);
    draftLanguage.current = lang;
    recording.current = stt.start(lang, {
      onInterim: (text) => dispatch({ type: "STT_INTERIM", text }),
      onFinal: (text) => dispatch({ type: "STT_FINAL", text }),
      onError: (code) => dispatch({ type: "STT_ERROR", code }),
      onEnd: () => {
        recording.current = null;
        setStopping(false);
        dispatch({ type: "STT_ENDED" });
      },
    });
    },
    [language, stt],
  );

  const stopListening = useCallback(() => {
    setStopping(true);
    recording.current?.stop();
  }, []);

  const edit = useCallback((text: string) => dispatch({ type: "EDIT", text }), []);

  const submit = useCallback(
    async (override?: string) => {
      if (!session) return;
      if (override !== undefined) dispatch({ type: "EDIT", text: override });
      const current = voiceRef.current;
      const text = (override ?? current.draft).trim();
      if (!text) return;
      const inputLanguage: SttLanguage =
        override !== undefined ? "en-US" : current.draftSource === "speech" ? (draftLanguage.current ?? language) : language;
      const retry = current.pending && current.pending.text === text && current.pending.language === inputLanguage;
      const requestId = retry ? current.pending!.requestId : crypto.randomUUID();
      silence();
      dispatch({ type: "SUBMIT", requestId, language: inputLanguage });
      try {
        // Only reviewed text is ever submitted: speech goes through TRANSCRIPT_REVIEW first (FR-05).
        const exchange = await api.submitTurn(session.id, { requestId, text, inputLanguage, verifiedByStudent: true });
        setSession((s) =>
          s && {
            ...s,
            ...exchange.session,
            turns: s.turns.some((t) => t.id === exchange.teacher.id) ? s.turns : [...s.turns, exchange.student, exchange.teacher],
          },
        );
        if (exchange.session.state !== "active") setPhase("completed");
        dispatch({ type: "SUBMIT_OK", speak: tts.supported });
        if (tts.supported) speak(exchange.teacher.text, exchange.teacher.id);
        else dispatch({ type: "TTS_FAILED", message: "這個瀏覽器不支援語音朗讀，老師的話會以文字顯示。" });
      } catch (err) {
        const e = err instanceof ApiError ? err : new ApiError("NETWORK_ERROR", "送出失敗，請再試一次。");
        if (e.code === "SESSION_NOT_ACTIVE") setPhase("completed");
        dispatch({ type: "SUBMIT_FAILED", code: e.code, message: e.message });
      }
    },
    [api, language, session, silence, speak, tts.supported],
  );

  const updateSettings = useCallback(
    (patch: Partial<Settings>) => {
      setSettings((s) => (s ? { ...s, ...patch } : s));
      api.updateSettings(patch).catch(() => setNotice("設定沒有存到伺服器，這堂課仍會使用新設定。"));
    },
    [api],
  );

  // When the lesson completes on its own, produce the summary right away, once; if that fails
  // the student retries with the button instead of this effect looping.
  const autoFinished = useRef<string | null>(null);
  useEffect(() => {
    if (phase !== "completed" || !session || session.summary || autoFinished.current === session.id) return;
    autoFinished.current = session.id;
    void finish({ stopSpeech: false });
  }, [phase, session, finish]);

  return {
    phase,
    lesson,
    session,
    history,
    settings,
    notice,
    voice,
    language,
    rate,
    speakingTurnId,
    paused,
    stopping,
    sttSupported: stt.supported,
    ttsSupported: tts.supported,
    start,
    resume,
    finish: () => finish(),
    replay,
    stopSpeaking,
    togglePause,
    listen,
    stopListening,
    edit,
    submit,
    skipRepeat: () => submit(SKIP_REPEAT_TEXT),
    setLanguage: (sttLanguage: SttLanguage) => updateSettings({ sttLanguage }),
    setRate: (speechRate: number) => updateSettings({ speechRate }),
  };
}

export type Classroom = ReturnType<typeof useClassroom>;
