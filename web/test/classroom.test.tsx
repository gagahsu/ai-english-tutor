import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api as realApi, type Exchange, type Lesson, type Session, type SessionSummary, type Settings, type TeacherTurn } from "../src/api";
import { Classroom } from "../src/classroom/Classroom";
import { SKIP_REPEAT_TEXT } from "../src/classroom/useClassroom";
import { DepsProvider, type Deps } from "../src/deps";
import type { SttEngine, SttHandlers } from "../src/voice/stt";
import { TtsError, type TtsEngine } from "../src/voice/tts";

// ---- fakes ----

class FakeTts implements TtsEngine {
  supported = true;
  spoken: string[] = [];
  private current: { resolve: () => void; reject: (e: Error) => void } | null = null;
  speak(text: string) {
    this.spoken.push(text);
    return new Promise<void>((resolve, reject) => (this.current = { resolve, reject }));
  }
  /** Finishes the utterance in progress. */
  async finish() {
    await act(async () => this.current?.resolve());
  }
  async fail(message: string) {
    await act(async () => this.current?.reject(new TtsError(message)));
  }
  pause() {}
  resume() {}
  /** The utterance that was playing at each cancel. */
  interrupted: (string | undefined)[] = [];
  cancel() {
    this.interrupted.push(this.spoken.at(-1));
    this.current?.resolve();
  }
  async voices() {
    return [];
  }
}

class FakeStt implements SttEngine {
  supported = true;
  languages: string[] = [];
  handlers: SttHandlers | null = null;
  start(language: "en-US" | "zh-TW", handlers: SttHandlers) {
    this.languages.push(language);
    this.handlers = handlers;
    return { stop: () => act(() => handlers.onEnd()), abort: () => {} };
  }
  hear(text: string) {
    act(() => this.handlers!.onFinal(text));
  }
  error(code: string) {
    act(() => {
      this.handlers!.onError(code);
      this.handlers!.onEnd();
    });
  }
}

const settings: Settings = {
  correctionMode: "balanced",
  speechRate: 1,
  teachingLanguage: "english",
  studentLevel: "A2",
  locale: "zh-TW",
  sttLanguage: "en-US",
};

const lesson: Lesson = {
  id: "l1",
  title: "A2 基礎會話z 1/10",
  level: "A2",
  course: "基礎會話",
  series: "z",
  unit: 1,
  totalUnits: 10,
  stale: false,
  lastSyncedAt: "2026-10-30T00:00:00Z",
  sections: [
    { id: "lm", kind: "learning-materials", title: "Learning materials", prompts: [], vocabulary: [], resources: [{ kind: "pdf", name: "worksheet.pdf", url: "/api/resources/b1" }], extractionStatus: "done" },
    { id: "wu", kind: "warm-up", title: "Warm-up", prompts: ["How was your week?"], vocabulary: [{ term: "busy", meaningZh: "忙碌" }], resources: [], extractionStatus: "done" },
  ],
};

const teacher = (id: string, text: string, extra: Partial<TeacherTurn> = {}): TeacherTurn => ({
  id,
  role: "teacher",
  text,
  lessonSectionId: "wu",
  intent: null,
  nextAction: "follow_up",
  assistance: null,
  degraded: false,
  createdAt: "",
  ...extra,
});

const session: Session = {
  id: "s1",
  state: "active",
  sectionId: "wu",
  sectionTitle: "Warm-up",
  questionIndex: 0,
  lessonId: "l1",
  lessonTitle: lesson.title,
  settings,
  startedAt: "",
  endedAt: null,
  turns: [teacher("t0", "Hello! How was your week?")],
  summary: null,
};

const summary: SessionSummary = {
  generatedAt: "2026-10-30T00:00:00Z",
  degraded: false,
  overviewZh: "你這次很努力地分享了一週的生活。",
  sectionsCovered: [{ id: "wu", title: "Warm-up" }],
  stats: { answers: 3, chineseHelp: 1, corrections: 1 },
  corrections: [{ type: "grammar", original: "I go to work", suggestion: "I went to work", reasonZh: "過去式" }],
  naturalExpressions: [{ original: "I watched the TV", better: "I watched TV" }],
  phrases: [{ english: "I stayed home.", zhExplanation: "待在家" }],
  vocabulary: [{ term: "busy", meaningZh: "忙碌" }],
  nextSteps: ["下次從「Short Talk」繼續這堂課。"],
};

function exchange(text: string, reply: TeacherTurn, state: Session["state"] = "active"): Exchange {
  return {
    student: { id: `st-${reply.id}`, role: "student", text, requestId: "x", inputLanguage: "en-US", verifiedByStudent: true, corrections: [], createdAt: "" },
    teacher: reply,
    session: { id: "s1", state, sectionId: "wu", sectionTitle: "Warm-up", questionIndex: 0 },
  };
}

let tts: FakeTts;
let stt: FakeStt;
let api: typeof realApi;

beforeEach(() => {
  // Like current Chrome, where scrollIntoView returns a Promise (an effect once returned it to React).
  Element.prototype.scrollIntoView = function () {
    return Promise.resolve() as unknown as void;
  };
  tts = new FakeTts();
  stt = new FakeStt();
  api = {
    ...realApi,
    getLesson: vi.fn(async () => lesson),
    getSettings: vi.fn(async () => settings),
    llmStatus: vi.fn(async () => ({ configured: true })),
    extractLesson: vi.fn(async () => ({})),
    updateSettings: vi.fn(async (patch: Partial<Settings>) => ({ ...settings, ...patch })),
    startSession: vi.fn(async () => structuredClone(session)),
    listSessions: vi.fn(async () => []),
    finishSession: vi.fn(),
    submitTurn: vi.fn(),
  };
});

async function openClass() {
  const deps: Deps = { api, stt, tts };
  render(
    <DepsProvider deps={deps}>
      <Classroom lessonId="l1" />
    </DepsProvider>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "開始上課" }));
  await screen.findByText("Hello! How was your week?", { selector: ".subtitle-text" });
  return user;
}

const status = () => document.querySelector(".status")!.textContent;
const micButton = () => screen.getByRole("button", { name: /開始回答|重錄/ });

describe("classroom", () => {
  it("opens with the teacher speaking and locks the microphone until she is done (AT-02, FR-04)", async () => {
    await openClass();
    expect(api.startSession).toHaveBeenCalledWith("l1", "wu");
    expect(tts.spoken).toEqual(["Hello! How was your week?"]);
    expect(status()).toBe("老師說話中");
    expect(micButton()).toHaveProperty("disabled", true);

    await tts.finish();
    expect(status()).toBe("輪到你回答");
    expect(micButton()).toHaveProperty("disabled", false);
  });

  it("records, shows an editable transcript, and submits only the reviewed text (AT-03, AT-08)", async () => {
    const user = await openClass();
    await tts.finish();
    vi.mocked(api.submitTurn).mockResolvedValue(exchange("It was busy.", teacher("t1", "Why was it busy?")));

    await user.click(micButton());
    expect(status()).toBe("錄音中");
    stt.hear("It was bossy");
    await user.click(screen.getByRole("button", { name: "■ 結束錄音" }));

    const box = screen.getByLabelText("辨識結果（可以修改後再送出）");
    expect(box).toHaveProperty("value", "It was bossy");
    await user.clear(box);
    await user.type(box, "It was busy.");
    await user.click(screen.getByRole("button", { name: "送出" }));

    expect(api.submitTurn).toHaveBeenCalledWith("s1", expect.objectContaining({ text: "It was busy.", inputLanguage: "en-US", verifiedByStudent: true }));
    await screen.findByText("Why was it busy?", { selector: ".subtitle-text" });
    expect(tts.spoken.at(-1)).toBe("Why was it busy?");
  });

  it("records in the chosen language", async () => {
    const user = await openClass();
    await tts.finish();
    await user.click(screen.getByRole("button", { name: "中文" }));
    await user.click(micButton());
    expect(stt.languages).toEqual(["zh-TW"]);
    expect(api.updateSettings).toHaveBeenCalledWith({ sttLanguage: "zh-TW" });
  });

  it("continues by text when the microphone is denied (AT-09)", async () => {
    const user = await openClass();
    await tts.finish();
    await user.click(micButton());
    stt.error("not-allowed");

    expect(screen.getByRole("alert").textContent).toContain("麥克風權限被拒絕");
    expect(screen.queryByRole("button", { name: /開始回答/ })).toBeNull();

    vi.mocked(api.submitTurn).mockResolvedValue(exchange("Good.", teacher("t1", "Great!")));
    await user.type(screen.getByRole("textbox"), "Good.");
    await user.click(screen.getByRole("button", { name: "送出" }));
    await screen.findByText("Great!", { selector: ".subtitle-text" });
  });

  it("shows the text and lets the lesson go on when TTS fails (AT-11)", async () => {
    const user = await openClass();
    await tts.fail("找不到英文語音");
    expect(status()).toBe("語音朗讀不可用");
    expect(screen.getByRole("alert").textContent).toContain("找不到英文語音");
    expect(screen.getByText("Hello! How was your week?", { selector: ".subtitle-text" })).toBeTruthy();
    expect(micButton()).toHaveProperty("disabled", false);
    await user.type(screen.getByRole("textbox"), "Fine.");
    expect(screen.getByRole("button", { name: "送出" })).toHaveProperty("disabled", false);
  });

  it("keeps the answer after an LLM error and resends it with the same requestId (AT-10)", async () => {
    const user = await openClass();
    await tts.finish();
    vi.mocked(api.submitTurn)
      .mockRejectedValueOnce(new ApiError("LLM_RATE_LIMIT", "AI 老師目前請求過多，請稍後再送出；你的回答已保留。", 429))
      .mockResolvedValueOnce(exchange("Fine.", teacher("t1", "Glad to hear it!")));

    await user.type(screen.getByRole("textbox"), "Fine.");
    await user.click(screen.getByRole("button", { name: "送出" }));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "AI 老師目前請求過多，請稍後再送出；你的回答已保留。");
    expect(status()).toBe("AI 老師忙碌中");
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Fine.");

    await user.click(screen.getByRole("button", { name: "重新送出" }));
    await screen.findByText("Glad to hear it!", { selector: ".subtitle-text" });
    const [first, second] = vi.mocked(api.submitTurn).mock.calls;
    expect(second![1].requestId).toBe(first![1].requestId);
  });

  it("offers Chinese help: shows the note, plays only English, and lets the student repeat or skip (AT-04)", async () => {
    const user = await openClass();
    await tts.finish();
    const help = teacher("t1", "You can say: I stayed home. Can you try saying that?", {
      intent: "chinese_assistance",
      nextAction: "repeat_or_skip",
      assistance: { english: "I stayed home.", zhExplanation: "stay home 待在家" },
    });
    vi.mocked(api.submitTurn).mockResolvedValueOnce(exchange("我待在家", help));
    await user.type(screen.getByRole("textbox"), "我待在家");
    await user.click(screen.getByRole("button", { name: "送出" }));
    await screen.findByText("stay home 待在家", { selector: ".chat-log .zh" });
    await tts.finish();

    await user.click(screen.getByRole("button", { name: "🔊 聽英文" }));
    expect(tts.spoken.at(-1)).toBe("I stayed home.");
    await tts.finish();

    // Repeating listens in English even if the toggle was on Chinese.
    await user.click(screen.getByRole("button", { name: "中文" }));
    await user.click(screen.getByRole("button", { name: "🎤 跟著說" }));
    expect(stt.languages.at(-1)).toBe("en-US");
    stt.hear("I stayed home.");
    await user.click(screen.getByRole("button", { name: "■ 結束錄音" }));
    vi.mocked(api.submitTurn).mockResolvedValueOnce(exchange("I stayed home.", teacher("t2", "Perfect!")));
    await user.click(screen.getByRole("button", { name: "送出" }));
    expect(vi.mocked(api.submitTurn).mock.lastCall![1]).toMatchObject({ text: "I stayed home.", inputLanguage: "en-US" });
  });

  it("can skip repeating the offered sentence", async () => {
    const user = await openClass();
    await tts.finish();
    const help = teacher("t1", "You can say: I stayed home. Can you try saying that?", {
      intent: "chinese_assistance",
      nextAction: "repeat_or_skip",
      assistance: { english: "I stayed home." },
    });
    vi.mocked(api.submitTurn)
      .mockResolvedValueOnce(exchange("我待在家", help))
      .mockResolvedValueOnce(exchange(SKIP_REPEAT_TEXT, teacher("t2", "OK! How was your week?")));
    await user.type(screen.getByRole("textbox"), "我待在家");
    await user.click(screen.getByRole("button", { name: "送出" }));
    await user.click(await screen.findByRole("button", { name: "跳過" }));
    expect(vi.mocked(api.submitTurn).mock.lastCall![1]).toMatchObject({ text: SKIP_REPEAT_TEXT, inputLanguage: "en-US" });
  });

  it("produces the summary by itself when the lesson completes, without cutting off the goodbye (FR-11)", async () => {
    const user = await openClass();
    await tts.finish();
    vi.mocked(api.submitTurn).mockResolvedValue(exchange("Bye", teacher("t1", "Goodbye!"), "completed"));
    vi.mocked(api.finishSession).mockResolvedValue({ ...session, state: "finished", summary });
    await user.type(screen.getByRole("textbox"), "Bye");
    await user.click(screen.getByRole("button", { name: "送出" }));

    await screen.findByRole("region", { name: "課後摘要" });
    expect(api.finishSession).toHaveBeenCalledTimes(1);
    expect(tts.spoken.at(-1)).toBe("Goodbye!");
    expect(tts.interrupted).not.toContain("Goodbye!");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("I went to work").className).toBe("to");
    expect(screen.getByText("I watched TV")).toBeTruthy();
    expect(screen.getByText("下次從「Short Talk」繼續這堂課。")).toBeTruthy();
  });

  it("lets the student end the lesson early and see the summary", async () => {
    const user = await openClass();
    vi.mocked(api.finishSession).mockResolvedValue({ ...session, state: "finished", summary });
    await user.click(screen.getByRole("button", { name: "結束課程" }));
    await screen.findByRole("region", { name: "課後摘要" });
    expect(status()).toBe("課程結束");
    expect(screen.queryByRole("button", { name: "結束課程" })).toBeNull();
  });

  it("offers a retry instead of looping when the summary fails", async () => {
    const user = await openClass();
    await tts.finish();
    vi.mocked(api.submitTurn).mockResolvedValue(exchange("Bye", teacher("t1", "Goodbye!"), "completed"));
    vi.mocked(api.finishSession)
      .mockRejectedValueOnce(new ApiError("NETWORK_ERROR", "無法連線到伺服器。"))
      .mockResolvedValueOnce({ ...session, state: "finished", summary: { ...summary, degraded: true } })
      .mockResolvedValueOnce({ ...session, state: "finished", summary });
    await user.type(screen.getByRole("textbox"), "Bye");
    await user.click(screen.getByRole("button", { name: "送出" }));

    await user.click(await screen.findByRole("button", { name: "產生課後摘要" }));
    expect(await screen.findByText(/AI 老師當時無法產生完整回顧/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "重新產生" }));
    await waitFor(() => expect(screen.queryByText(/AI 老師當時無法產生完整回顧/)).toBeNull());
    expect(api.finishSession).toHaveBeenCalledTimes(3);
  });

  it("continues an unfinished session where it stopped (FR-10, AT-12)", async () => {
    vi.mocked(api.listSessions).mockResolvedValue([
      { id: "old", state: "active", sectionId: "wu", sectionTitle: "Warm-up", questionIndex: 1, lessonId: "l1", lessonTitle: lesson.title, startedAt: "2026-10-29T10:00:00Z", endedAt: null, answers: 4, hasSummary: false },
      { id: "done", state: "finished", sectionId: null, sectionTitle: null, questionIndex: 0, lessonId: "l1", lessonTitle: lesson.title, startedAt: "2026-10-28T10:00:00Z", endedAt: "2026-10-28T10:30:00Z", answers: 9, hasSummary: true },
    ]);
    vi.spyOn(api, "getSession").mockResolvedValue({
      ...session,
      id: "old",
      turns: [teacher("t0", "Hello!"), teacher("t9", "What did you do last weekend?")],
    });
    render(
      <DepsProvider deps={{ api, stt, tts }}>
        <Classroom lessonId="l1" />
      </DepsProvider>,
    );
    const user = userEvent.setup();
    expect((await screen.findByText(/已回答 4 次/)).textContent).toContain("目前在「Warm-up」");
    expect(screen.getByRole("link", { name: /10\/28/ }).getAttribute("href")).toBe("#/sessions/done");

    await user.click(screen.getByRole("button", { name: "繼續上課" }));
    await screen.findByText("What did you do last weekend?", { selector: ".subtitle-text" });
    expect(api.getSession).toHaveBeenCalledWith("old");
    expect(api.startSession).not.toHaveBeenCalled();
    expect(tts.spoken).toEqual(["What did you do last weekend?"]);
  });

  it("extracts lesson material before the first class", async () => {
    vi.mocked(api.getLesson).mockResolvedValueOnce({ ...lesson, sections: lesson.sections.map((s) => ({ ...s, extractionStatus: "pending" as const })) });
    render(
      <DepsProvider deps={{ api, stt, tts }}>
        <Classroom lessonId="l1" />
      </DepsProvider>,
    );
    await screen.findByRole("button", { name: "開始上課" });
    expect(api.extractLesson).toHaveBeenCalledWith("l1");
  });

  it("only links to safe lesson resources", async () => {
    await openClass();
    const link = screen.getByRole("link", { name: "worksheet.pdf" });
    expect(link.getAttribute("href")).toBe("/api/resources/b1");
    expect(link.getAttribute("rel")).toContain("noopener");
    await waitFor(() => expect(screen.getByText("busy")).toBeTruthy());
  });
});
