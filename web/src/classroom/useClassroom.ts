import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ApiError, type Lesson, type Session, type Settings, type SttLanguage, type TeacherTurn } from "../api";
import { useDeps } from "../deps";
import { canListen, initialVoiceState, voiceReducer } from "../voice/machine";
import type { SttRecording } from "../voice/stt";
import { TtsError } from "../voice/tts";

export type Phase = "loading" | "preparing" | "ready" | "starting" | "active" | "completed" | "error";

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

  // Load the lesson, and run the one-time section extraction first if it has not happened yet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [loaded, loadedSettings, llm] = await Promise.all([api.getLesson(lessonId), api.getSettings(), api.llmStatus()]);
        if (cancelled) return;
        setSettings(loadedSettings);
        setLesson(loaded);
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

  const start = useCallback(
    async (sectionId?: string) => {
      setPhase("starting");
      setNotice(null);
      try {
        const started = await api.startSession(lessonId, sectionId);
        setSession(started);
        setPhase(started.state === "active" ? "active" : "completed");
        const opening = started.turns.findLast((t): t is TeacherTurn => t.role === "teacher");
        dispatch({ type: "LESSON_STARTED", speak: !!opening && tts.supported });
        if (opening && tts.supported) speak(opening.text, opening.id);
        else if (!tts.supported) dispatch({ type: "TTS_FAILED", message: "這個瀏覽器不支援語音朗讀，老師的話會以文字顯示。" });
      } catch (err) {
        setNotice(err instanceof ApiError ? err.message : "無法開始上課。");
        setPhase("ready");
      }
    },
    [api, lessonId, speak, tts.supported],
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

  return {
    phase,
    lesson,
    session,
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
