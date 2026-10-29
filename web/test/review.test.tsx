import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api as realApi, type Session } from "../src/api";
import { DepsProvider } from "../src/deps";
import { SessionReview } from "../src/pages/SessionReview";
import type { SttEngine } from "../src/voice/stt";
import type { TtsEngine } from "../src/voice/tts";

const finished: Session = {
  id: "s1",
  state: "finished",
  sectionId: null,
  sectionTitle: null,
  questionIndex: 0,
  lessonId: "l1",
  lessonTitle: "A2 基礎會話z 1/10",
  settings: { correctionMode: "balanced", speechRate: 1, teachingLanguage: "english", studentLevel: "A2", locale: "zh-TW", sttLanguage: "en-US" },
  startedAt: "2026-10-28T10:00:00Z",
  endedAt: "2026-10-28T10:30:00Z",
  turns: [
    { id: "t0", role: "teacher", text: "How was your week?", lessonSectionId: "wu", intent: null, nextAction: "follow_up", assistance: null, degraded: false, createdAt: "" },
    { id: "t1", role: "student", text: "It was busy.", requestId: "r", inputLanguage: "en-US", verifiedByStudent: true, corrections: [], createdAt: "" },
  ],
  summary: {
    generatedAt: "",
    degraded: false,
    overviewZh: "你這次表現很好。",
    sectionsCovered: [{ id: "wu", title: "Warm-up" }],
    stats: { answers: 1, chineseHelp: 0, corrections: 0 },
    corrections: [],
    naturalExpressions: [],
    phrases: [],
    vocabulary: [],
    nextSteps: ["多練習過去式。"],
  },
};

let api: typeof realApi;
const noSpeech = { stt: { supported: false } as SttEngine, tts: { supported: false } as TtsEngine };

beforeEach(() => {
  api = { ...realApi, getSession: vi.fn(async () => finished), deleteSession: vi.fn(async () => null), finishSession: vi.fn() };
  window.location.hash = "#/sessions/s1";
});

function open() {
  render(
    <DepsProvider deps={{ api, ...noSpeech }}>
      <SessionReview sessionId="s1" />
    </DepsProvider>,
  );
}

describe("session review", () => {
  it("shows a past session's summary and conversation (AT-12)", async () => {
    open();
    expect(await screen.findByText("你這次表現很好。")).toBeTruthy();
    expect(screen.getByText("It was busy.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "← A2 基礎會話z 1/10" }).getAttribute("href")).toBe("#/lessons/l1");
  });

  it("generates a missing summary for an unfinished session", async () => {
    vi.mocked(api.getSession).mockResolvedValue({ ...finished, state: "active", summary: null });
    vi.mocked(api.finishSession).mockResolvedValue(finished);
    open();
    await userEvent.click(await screen.findByRole("button", { name: "現在結束並產生摘要" }));
    expect(await screen.findByText("你這次表現很好。")).toBeTruthy();
  });

  it("deletes the session only after confirmation (NFR-05)", async () => {
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "刪除這次紀錄" }));
    expect(api.deleteSession).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "確定刪除" }));
    expect(api.deleteSession).toHaveBeenCalledWith("s1");
    expect(window.location.hash).toBe("#/lessons/l1");
  });
});
