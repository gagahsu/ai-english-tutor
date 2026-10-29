import type { SttLanguage } from "../api";

// Speech-to-text through the browser's SpeechRecognition (Chrome/Edge). Audio never reaches our
// server and is not stored; the browser vendor may process it in the cloud (shown in the UI).

export interface SttHandlers {
  /** Not-yet-final words, for live display only. */
  onInterim(text: string): void;
  /** All final text recognised so far in this recording. */
  onFinal(text: string): void;
  /** A SpeechRecognition error code, e.g. "not-allowed", "no-speech", "network". */
  onError(code: string): void;
  onEnd(): void;
}

export interface SttRecording {
  /** Stop listening and deliver what was heard. */
  stop(): void;
  /** Stop and discard. */
  abort(): void;
}

export interface SttEngine {
  readonly supported: boolean;
  start(language: SttLanguage, handlers: SttHandlers): SttRecording;
}

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => RecognitionLike;

export function createBrowserStt(win: Window = window): SttEngine {
  const w = win as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return {
    supported: !!Ctor,
    start(language, handlers) {
      if (!Ctor) {
        queueMicrotask(() => handlers.onError("language-not-supported"));
        return { stop() {}, abort() {} };
      }
      const rec = new Ctor();
      // Explicit language per recording; mixed-language auto-detection is not assumed (SRS §5).
      rec.lang = language;
      // Manual start/stop (FR-04): keep listening through pauses until the student presses stop.
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => {
        let final = "";
        let interim = "";
        for (const result of Array.from(e.results)) {
          if (result.isFinal) final += result[0].transcript;
          else interim += result[0].transcript;
        }
        handlers.onFinal(final.trim());
        handlers.onInterim(interim.trim());
      };
      rec.onerror = (e) => handlers.onError(e.error);
      rec.onend = () => handlers.onEnd();
      try {
        rec.start();
      } catch {
        queueMicrotask(() => handlers.onError("audio-capture"));
      }
      return { stop: () => rec.stop(), abort: () => rec.abort() };
    },
  };
}
