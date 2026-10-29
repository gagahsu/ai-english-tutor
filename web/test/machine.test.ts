import { describe, expect, it } from "vitest";
import { canListen, canSubmit, initialVoiceState, voiceReducer, type VoiceEvent, type VoiceState } from "../src/voice/machine";

const run = (events: VoiceEvent[], from: VoiceState = initialVoiceState(true)) => events.reduce(voiceReducer, from);
const started = (speak = true) => run([{ type: "LESSON_STARTED", speak }]);

describe("voice state machine", () => {
  it("walks the main loop: teacher → wait → listen → review → think → teacher", () => {
    let s = started();
    expect(s.status).toBe("TEACHER_SPEAKING");
    expect(canListen(s)).toBe(false); // no recording while the teacher speaks

    s = run([{ type: "TTS_ENDED" }], s);
    expect(s.status).toBe("WAITING_FOR_STUDENT");

    s = run([{ type: "LISTEN" }, { type: "STT_INTERIM", text: "I went" }, { type: "STT_FINAL", text: "I went hiking" }], s);
    expect(s).toMatchObject({ status: "LISTENING", draft: "I went hiking", draftSource: "speech" });

    s = run([{ type: "STT_ENDED" }, { type: "EDIT", text: "I went hiking." }], s);
    expect(s).toMatchObject({ status: "TRANSCRIPT_REVIEW", draft: "I went hiking.", draftSource: "speech" });

    s = run([{ type: "SUBMIT", requestId: "r1", language: "en-US" }], s);
    expect(s).toMatchObject({ status: "THINKING", pending: { requestId: "r1", text: "I went hiking." } });
    expect(canSubmit(s)).toBe(false);

    s = run([{ type: "SUBMIT_OK", speak: true }], s);
    expect(s).toMatchObject({ status: "TEACHER_SPEAKING", draft: "", pending: null });
  });

  it("goes to STT_NO_MATCH when nothing was recognised", () => {
    const s = run([{ type: "TTS_ENDED" }, { type: "LISTEN" }, { type: "STT_ENDED" }], started());
    expect(s.status).toBe("STT_NO_MATCH");
    expect(canListen(s)).toBe(true);
  });

  it("falls back to text when the microphone is denied (AT-09)", () => {
    const s = run([{ type: "TTS_ENDED" }, { type: "LISTEN" }, { type: "STT_ERROR", code: "not-allowed" }], started());
    expect(s).toMatchObject({ status: "MIC_DENIED", sttAvailable: false });
    expect(s.error).toContain("麥克風");
    expect(canListen(s)).toBe(false);

    const typed = run([{ type: "EDIT", text: "I stayed home." }], s);
    expect(typed).toMatchObject({ status: "TRANSCRIPT_REVIEW", draftSource: "typed", error: null });
    expect(canSubmit(typed)).toBe(true);
  });

  it("starts in text mode without speech recognition", () => {
    const s = initialVoiceState(false);
    expect(s).toMatchObject({ status: "STT_UNSUPPORTED", sttAvailable: false });
    expect(run([{ type: "LESSON_STARTED", speak: true }, { type: "TTS_ENDED" }], s).status).toBe("WAITING_FOR_STUDENT");
  });

  it("keeps going without audio when TTS fails (AT-11)", () => {
    const s = run([{ type: "TTS_FAILED", message: "no voice" }], started());
    expect(s).toMatchObject({ status: "TTS_UNAVAILABLE", error: "no voice" });
    expect(canListen(s)).toBe(true);
    expect(run([{ type: "EDIT", text: "Hi" }], s).status).toBe("TRANSCRIPT_REVIEW");
  });

  it("keeps the answer and its requestId after an LLM error so a resend is deduplicated (AT-10)", () => {
    let s = run([{ type: "TTS_ENDED" }, { type: "EDIT", text: "Hello" }, { type: "SUBMIT", requestId: "r1", language: "en-US" }], started());
    s = run([{ type: "SUBMIT_FAILED", code: "LLM_RATE_LIMIT", message: "busy" }], s);
    expect(s).toMatchObject({ status: "LLM_RATE_LIMIT", draft: "Hello", pending: { requestId: "r1" }, error: "busy" });

    const resent = run([{ type: "SUBMIT", requestId: "r2", language: "en-US" }], s);
    expect(resent.pending?.requestId).toBe("r1");

    const changed = run([{ type: "EDIT", text: "Hello there" }, { type: "SUBMIT", requestId: "r3", language: "en-US" }], s);
    expect(changed.pending?.requestId).toBe("r3");

    expect(run([{ type: "SUBMIT_FAILED", code: "NETWORK_ERROR", message: "offline" }], run([{ type: "SUBMIT", requestId: "r4", language: "en-US" }], s)).status).toBe(
      "NETWORK_ERROR",
    );
  });

  it("lets the student type while the teacher speaks and returns to that draft afterwards", () => {
    let s = run([{ type: "EDIT", text: "My answer" }], started());
    expect(s).toMatchObject({ status: "TEACHER_SPEAKING", draft: "My answer" });
    s = run([{ type: "STOP_SPEAKING" }], s);
    expect(s.status).toBe("TRANSCRIPT_REVIEW");
  });

  it("ignores events that do not fit the current state", () => {
    const thinking = run([{ type: "TTS_ENDED" }, { type: "EDIT", text: "x" }, { type: "SUBMIT", requestId: "r", language: "en-US" }], started());
    expect(run([{ type: "LISTEN" }], thinking).status).toBe("THINKING");
    expect(run([{ type: "REPLAY" }], thinking).status).toBe("THINKING");
    expect(run([{ type: "EDIT", text: "y" }], thinking).draft).toBe("x");
    expect(run([{ type: "STT_ENDED" }], started()).status).toBe("TEACHER_SPEAKING");
  });

  it("maps recognition errors to their exception states", () => {
    const listening = run([{ type: "TTS_ENDED" }, { type: "LISTEN" }], started());
    expect(run([{ type: "STT_ERROR", code: "network" }], listening).status).toBe("NETWORK_ERROR");
    expect(run([{ type: "STT_ERROR", code: "no-speech" }], listening).status).toBe("STT_NO_MATCH");
    expect(run([{ type: "STT_ERROR", code: "audio-capture" }], listening).status).toBe("MIC_DENIED");
    expect(run([{ type: "STT_ERROR", code: "language-not-supported" }], listening).status).toBe("STT_UNSUPPORTED");
    expect(run([{ type: "STT_ERROR", code: "aborted" }], listening).status).toBe("WAITING_FOR_STUDENT");
  });
});
