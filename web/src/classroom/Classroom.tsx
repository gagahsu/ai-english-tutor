import { useEffect, useRef, useState } from "react";
import type { LessonSection, StudentTurn, TeacherTurn } from "../api";
import { safeUrl } from "../safeUrl";
import { canListen, canSubmit, canType, type VoiceStatus } from "../voice/machine";
import { useClassroom, type Classroom as ClassroomState } from "./useClassroom";

const STATUS_TEXT: Record<VoiceStatus, string> = {
  IDLE: "尚未開始",
  TEACHER_SPEAKING: "老師說話中",
  WAITING_FOR_STUDENT: "輪到你回答",
  LISTENING: "錄音中",
  TRANSCRIPT_REVIEW: "請確認你的回答",
  THINKING: "AI 老師思考中…",
  MIC_DENIED: "無法使用麥克風",
  STT_UNSUPPORTED: "語音辨識不可用",
  STT_NO_MATCH: "沒有辨識到內容",
  NETWORK_ERROR: "連線出錯",
  LLM_RATE_LIMIT: "AI 老師忙碌中",
  TTS_UNAVAILABLE: "語音朗讀不可用",
};

const ERROR_STATES = new Set<VoiceStatus>(["MIC_DENIED", "STT_UNSUPPORTED", "STT_NO_MATCH", "NETWORK_ERROR", "LLM_RATE_LIMIT", "TTS_UNAVAILABLE"]);

type Tab = "material" | "chat" | "notes";

export function Classroom({ lessonId }: { lessonId: string }) {
  const c = useClassroom(lessonId);
  const [tab, setTab] = useState<Tab>("chat");

  if (c.phase === "loading" || c.phase === "preparing" || !c.lesson) {
    return (
      <div className="page-message">
        {c.phase === "error" ? (
          <>
            <p role="alert">{c.notice}</p>
            <a href="#/">回課程列表</a>
          </>
        ) : (
          <p aria-live="polite">{c.phase === "preparing" ? "第一次上這堂課，正在整理教材（約 10–30 秒）…" : "載入課程中…"}</p>
        )}
      </div>
    );
  }

  return (
    <div className="classroom">
      <header className="classroom-header">
        <a href="#/" className="back">
          ← 課程列表
        </a>
        <h1>{c.lesson.title}</h1>
        <StatusBadge c={c} />
      </header>

      <nav className="tabs" aria-label="切換區塊">
        {(
          [
            ["material", "教材"],
            ["chat", "對話"],
            ["notes", "筆記"],
          ] as const
        ).map(([key, label]) => (
          <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>

      <div className="classroom-grid" data-tab={tab}>
        <SectionsPanel c={c} />
        <section className="panel chat-panel" aria-label="對話">
          {c.notice && (
            <p className="notice" role="status">
              {c.notice}
            </p>
          )}
          {c.phase === "ready" || c.phase === "starting" ? <StartCard c={c} /> : <Conversation c={c} />}
        </section>
        <NotesPanel c={c} />
      </div>
      {(c.phase === "active" || c.phase === "completed") && <ControlBar c={c} />}
    </div>
  );
}

function StatusBadge({ c }: { c: ClassroomState }) {
  const { status } = c.voice;
  const label = c.phase === "completed" && !ERROR_STATES.has(status) && status !== "TEACHER_SPEAKING" ? "課程完成" : STATUS_TEXT[status];
  const text = status === "LISTENING" && c.stopping ? "正在辨識…" : label;
  return (
    <span className="status" data-status={status} aria-live="polite">
      {text}
    </span>
  );
}

function StartCard({ c }: { c: ClassroomState }) {
  const sections = c.lesson!.sections.filter((s) => s.kind !== "learning-materials");
  const [sectionId, setSectionId] = useState(sections.find((s) => s.kind === "warm-up")?.id ?? sections[0]?.id ?? "");
  return (
    <div className="start-card">
      <h2>準備上課</h2>
      <p>老師會用英文帶你一題一題練習。播完老師的話後，按麥克風回答，確認辨識結果再送出；也可以直接打字。</p>
      <label>
        從哪個章節開始
        <select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      </label>
      {!c.sttSupported && <p className="hint">這個瀏覽器不支援語音辨識，這堂課會用打字作答。</p>}
      {!c.ttsSupported && <p className="hint">這個瀏覽器不支援語音朗讀，老師的話會以文字顯示。</p>}
      <button type="button" className="primary" disabled={c.phase === "starting" || !sectionId} onClick={() => c.start(sectionId)}>
        {c.phase === "starting" ? "老師準備中…" : "開始上課"}
      </button>
    </div>
  );
}

function Conversation({ c }: { c: ClassroomState }) {
  const turns = c.session?.turns ?? [];
  const lastTeacher = turns.findLast((t): t is TeacherTurn => t.role === "teacher");
  const logEnd = useRef<HTMLDivElement>(null);
  // Block body on purpose: newer Chrome returns a Promise from scrollIntoView, which React would
  // otherwise take for this effect's cleanup function and crash on.
  useEffect(() => {
    logEnd.current?.scrollIntoView?.({ block: "end" });
  }, [turns.length]);

  return (
    <>
      {lastTeacher && (
        <div className="subtitle" aria-live="polite">
          <p className="subtitle-text">{lastTeacher.text}</p>
          <div className="speech-controls">
            <button type="button" onClick={() => c.replay(lastTeacher.text, lastTeacher.id)} disabled={c.voice.status === "LISTENING" || c.voice.status === "THINKING"}>
              ↻ 重播
            </button>
            {c.voice.status === "TEACHER_SPEAKING" && (
              <>
                <button type="button" onClick={c.togglePause}>
                  {c.paused ? "▶ 繼續" : "⏸ 暫停"}
                </button>
                <button type="button" onClick={c.stopSpeaking}>
                  ■ 停止
                </button>
              </>
            )}
            <label className="rate">
              語速 {c.rate.toFixed(1)}
              <input type="range" min={0.5} max={1.5} step={0.1} value={c.rate} onChange={(e) => c.setRate(Number(e.target.value))} />
            </label>
          </div>
        </div>
      )}
      <ol className="chat-log">
        {turns.map((t) =>
          t.role === "teacher" ? (
            <TeacherMessage key={t.id} turn={t} c={c} latest={t.id === lastTeacher?.id} />
          ) : (
            <StudentMessage key={t.id} turn={t} />
          ),
        )}
        {c.voice.status === "THINKING" && c.voice.pending && (
          <li className="msg student pending">
            <p>{c.voice.pending.text}</p>
          </li>
        )}
      </ol>
      {c.phase === "completed" && (
        <div className="done-card" role="status">
          <h2>這堂課完成了！</h2>
          <p>對話紀錄已保存。課後摘要（字彙、修正、更自然的說法）會在下一版加入。</p>
          <a href="#/">回課程列表</a>
        </div>
      )}
      <div ref={logEnd} />
    </>
  );
}

function TeacherMessage({ turn, c, latest }: { turn: TeacherTurn; c: ClassroomState; latest: boolean }) {
  const offered = turn.nextAction === "repeat_or_skip" && turn.assistance;
  return (
    <li className="msg teacher" data-speaking={c.speakingTurnId === turn.id || undefined}>
      <p>{turn.text}</p>
      {turn.degraded && <p className="hint">（AI 老師暫時無法正常回覆，這是備用訊息）</p>}
      {turn.assistance && (
        <div className="assistance">
          <p className="english" lang="en">
            {turn.assistance.english}
          </p>
          {turn.assistance.zhExplanation && <p className="zh">{turn.assistance.zhExplanation}</p>}
          <div className="row">
            <button type="button" onClick={() => c.replay(turn.assistance!.english, turn.id)} disabled={c.voice.status === "LISTENING" || c.voice.status === "THINKING"}>
              🔊 聽英文
            </button>
            {offered && latest && c.phase === "active" && (
              <>
                {c.sttSupported && c.voice.sttAvailable && (
                  <button type="button" onClick={() => c.listen("en-US")} disabled={!canListen(c.voice)}>
                    🎤 跟著說
                  </button>
                )}
                <button type="button" onClick={c.skipRepeat} disabled={!canType(c.voice)}>
                  跳過
                </button>
              </>
            )}
          </div>
        </div>
      )}
      <button type="button" className="link" onClick={() => c.replay(turn.text, turn.id)} disabled={c.voice.status === "LISTENING" || c.voice.status === "THINKING"}>
        重播這句
      </button>
    </li>
  );
}

function StudentMessage({ turn }: { turn: StudentTurn }) {
  return (
    <li className="msg student">
      <p lang={turn.inputLanguage === "zh-TW" ? "zh-Hant-TW" : "en"}>{turn.text}</p>
      {turn.corrections.map((x, i) => (
        <p key={i} className="correction">
          <span className="from">{x.original}</span> → <span className="to">{x.suggestion}</span>
          {x.reasonZh && <span className="why">（{x.reasonZh}）</span>}
        </p>
      ))}
    </li>
  );
}

function ControlBar({ c }: { c: ClassroomState }) {
  const { voice } = c;
  const listening = voice.status === "LISTENING";
  const completed = c.phase === "completed";
  const retryable = voice.status === "NETWORK_ERROR" || voice.status === "LLM_RATE_LIMIT";
  const speechDraft = voice.draftSource === "speech" && voice.status === "TRANSCRIPT_REVIEW";

  return (
    <footer className="control-bar" aria-label="回答">
      {voice.error && (
        <p className="error" role="alert">
          {voice.error}
        </p>
      )}
      {!completed && (
        <>
          <div className="row">
            <fieldset className="lang" disabled={listening}>
              <legend className="sr-only">辨識語言</legend>
              {(
                [
                  ["en-US", "English"],
                  ["zh-TW", "中文"],
                ] as const
              ).map(([code, label]) => (
                <button key={code} type="button" aria-pressed={c.language === code} onClick={() => c.setLanguage(code)}>
                  {label}
                </button>
              ))}
            </fieldset>
            {c.sttSupported && voice.sttAvailable && (
              <button
                type="button"
                className={listening ? "mic recording" : "mic"}
                onClick={listening ? c.stopListening : () => c.listen()}
                disabled={listening ? c.stopping : !canListen(voice)}
                title={voice.status === "TEACHER_SPEAKING" ? "老師說完後才能錄音" : undefined}
              >
                {listening ? (c.stopping ? "辨識中…" : "■ 結束錄音") : speechDraft ? "🎤 重錄" : "🎤 開始回答"}
              </button>
            )}
          </div>
          {listening && (
            <p className="interim" aria-live="polite">
              {[voice.draft, voice.interim].filter(Boolean).join(" ") || "請開始說話…"}
            </p>
          )}
          <form
            className="answer"
            onSubmit={(e) => {
              e.preventDefault();
              void c.submit();
            }}
          >
            <label htmlFor="answer" className={speechDraft ? "" : "sr-only"}>
              {speechDraft ? "辨識結果（可以修改後再送出）" : "打字回答"}
            </label>
            <textarea
              id="answer"
              rows={2}
              value={listening ? "" : voice.draft}
              placeholder={c.language === "zh-TW" ? "可以用中文或中英混合回答" : "Type your answer here"}
              disabled={!canType(voice)}
              onChange={(e) => c.edit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void c.submit();
                }
              }}
            />
            <button type="submit" className="primary" disabled={!canSubmit(voice)}>
              {retryable && voice.pending?.text === voice.draft.trim() ? "重新送出" : "送出"}
            </button>
          </form>
        </>
      )}
    </footer>
  );
}

function SectionsPanel({ c }: { c: ClassroomState }) {
  const current = c.session?.sectionId;
  const materials = c.lesson!.sections.filter((s) => s.kind === "learning-materials").flatMap((s) => s.resources);
  return (
    <aside className="panel sections-panel" aria-label="章節">
      <h2>章節</h2>
      <ol className="sections">
        {c.lesson!.sections
          .filter((s) => s.kind !== "learning-materials")
          .map((s) => (
            <li key={s.id} aria-current={s.id === current ? "step" : undefined}>
              {s.title}
              {s.id === current && c.session && s.prompts.length > 0 && (
                <span className="progress">
                  {" "}
                  {Math.min(c.session.questionIndex + 1, s.prompts.length)}/{s.prompts.length}
                </span>
              )}
            </li>
          ))}
      </ol>
      {materials.length > 0 && (
        <>
          <h2>講義</h2>
          <ul className="resources">
            {materials.map((r, i) => {
              const url = safeUrl(r.url);
              return <li key={i}>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{r.name ?? "教材檔案"}</a> : (r.name ?? "教材檔案（無法開啟）")}</li>;
            })}
          </ul>
        </>
      )}
    </aside>
  );
}

function NotesPanel({ c }: { c: ClassroomState }) {
  const section: LessonSection | undefined = c.lesson!.sections.find((s) => s.id === c.session?.sectionId);
  const turns = c.session?.turns ?? [];
  const phrases = turns.filter((t): t is TeacherTurn => t.role === "teacher" && !!t.assistance).map((t) => t.assistance!);
  return (
    <aside className="panel notes-panel" aria-label="筆記">
      <h2>字彙{section ? `：${section.title}` : ""}</h2>
      {section?.vocabulary.length ? (
        <ul className="vocab">
          {section.vocabulary.map((v) => (
            <li key={v.term}>
              <span lang="en">{v.term}</span>
              {v.meaningZh && <span className="zh">{v.meaningZh}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">{section ? "這個章節沒有字彙表。" : "開始上課後顯示目前章節的字彙。"}</p>
      )}
      {phrases.length > 0 && (
        <>
          <h2>老師教的說法</h2>
          <ul className="phrases">
            {phrases.map((p, i) => (
              <li key={i}>
                <span lang="en">{p.english}</span>
                {p.zhExplanation && <span className="zh">{p.zhExplanation}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="privacy">
        隱私：不會錄下或保存你的聲音。語音辨識由瀏覽器處理（Chrome/Edge 可能傳到 Google 或 Microsoft 雲端）；你的文字回答與這堂課的教材會傳給 Mistral 產生老師回覆。
      </p>
    </aside>
  );
}
