import { useEffect, useState } from "react";
import { ApiError, type Session } from "../api";
import { formatDate } from "../classroom/Classroom";
import { SummaryView } from "../components/SummaryView";
import { useDeps } from "../deps";

/** A past session: its summary and the full conversation, read-only (AT-12). */
export function SessionReview({ sessionId }: { sessionId: string }) {
  const { api } = useDeps();
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    api.getSession(sessionId).then(setSession, (err) => setError(err instanceof ApiError ? err.message : "無法載入上課紀錄。"));
  }, [api, sessionId]);

  async function summarize() {
    setBusy(true);
    setError(null);
    try {
      setSession(await api.finishSession(sessionId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "無法產生課後摘要。");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteSession(sessionId);
      window.location.hash = session ? `#/lessons/${encodeURIComponent(session.lessonId)}` : "#/";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "刪除失敗。");
      setBusy(false);
    }
  }

  if (!session) {
    return (
      <main className="page">
        <a href="#/">← 課程列表</a>
        <p role={error ? "alert" : undefined}>{error ?? "載入中…"}</p>
      </main>
    );
  }

  const lessonLink = `#/lessons/${encodeURIComponent(session.lessonId)}`;
  return (
    <main className="page">
      <header className="page-header stacked">
        <a href={lessonLink}>← {session.lessonTitle}</a>
        <h1>{formatDate(session.startedAt)} 的上課紀錄</h1>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {session.summary ? (
        <SummaryView summary={session.summary} onRetry={summarize} retrying={busy} />
      ) : session.state === "active" ? (
        <p className="notice">
          這堂課還沒結束。<a href={lessonLink}>回到課程繼續上課</a>，或
          <button type="button" className="link" onClick={summarize} disabled={busy}>
            {busy ? "整理中…" : "現在結束並產生摘要"}
          </button>
        </p>
      ) : (
        <button type="button" className="primary" onClick={summarize} disabled={busy}>
          {busy ? "整理中…" : "產生課後摘要"}
        </button>
      )}

      <h2>對話紀錄</h2>
      <ol className="chat-log">
        {session.turns.map((t) => (
          <li key={t.id} className={`msg ${t.role}`}>
            <p lang={t.role === "student" && t.inputLanguage === "zh-TW" ? "zh-Hant-TW" : "en"}>{t.text}</p>
            {t.role === "teacher" && t.assistance && (
              <p className="zh">
                {t.assistance.english}
                {t.assistance.zhExplanation && `（${t.assistance.zhExplanation}）`}
              </p>
            )}
          </li>
        ))}
      </ol>

      <section className="danger">
        {confirmDelete ? (
          <p>
            確定刪除這次的上課紀錄？刪除後無法復原。{" "}
            <button type="button" onClick={remove} disabled={busy}>
              確定刪除
            </button>{" "}
            <button type="button" onClick={() => setConfirmDelete(false)}>
              取消
            </button>
          </p>
        ) : (
          <button type="button" className="link" onClick={() => setConfirmDelete(true)}>
            刪除這次紀錄
          </button>
        )}
      </section>
    </main>
  );
}
