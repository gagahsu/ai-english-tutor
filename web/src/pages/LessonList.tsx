import { useCallback, useEffect, useState } from "react";
import { ApiError, type LessonSummary, type ServiceStatus, type SyncResult } from "../api";
import { useDeps } from "../deps";

export function LessonList() {
  const { api } = useDeps();
  const [lessons, setLessons] = useState<LessonSummary[] | null>(null);
  const [notion, setNotion] = useState<ServiceStatus | null>(null);
  const [llm, setLlm] = useState<ServiceStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLessons(await api.listLessons());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "無法載入課程列表。");
    }
  }, [api]);

  useEffect(() => {
    void load();
    api.notionStatus().then(setNotion, () => setNotion(null));
    api.llmStatus().then(setLlm, () => setLlm(null));
  }, [api, load]);

  async function sync() {
    setSyncing(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.syncLessons());
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "同步失敗。");
    } finally {
      setSyncing(false);
    }
  }

  const changed = result?.lessons.filter((l) => l.status !== "unchanged") ?? [];

  return (
    <main className="page">
      <header className="page-header">
        <h1>AI 英文家教</h1>
        <a href="#/settings">設定與裝置檢查</a>
      </header>

      <section className="services" aria-label="服務狀態">
        <ServiceLine label="Notion" status={notion} okText={notion?.databaseTitle ? `已連線（${notion.databaseTitle}）` : "已連線"} />
        <ServiceLine label="AI 老師" status={llm} okText={llm?.model ? `已設定（${llm.model}）` : "已設定"} />
      </section>

      <section className="sync">
        <button type="button" className="primary" onClick={sync} disabled={syncing || notion?.configured === false}>
          {syncing ? "同步中…（第一次約需 2 分鐘）" : "從 Notion 同步"}
        </button>
        {result && (
          <div className="sync-result" role="status">
            <p>
              同步完成：{result.lessons.length} 堂課，{changed.length ? `${changed.length} 堂有更新` : "沒有變更"}。
            </p>
            {result.warnings.length > 0 && (
              <ul className="warnings">
                {result.warnings.map((w, i) => (
                  <li key={i}>
                    {w.lessonTitle ? `${w.lessonTitle}：` : ""}
                    {w.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>

      <section aria-label="課程">
        <h2>選一堂課</h2>
        {lessons === null ? (
          <p>載入中…</p>
        ) : lessons.length === 0 ? (
          <p className="hint">還沒有課程，請先從 Notion 同步。</p>
        ) : (
          <ul className="lesson-list">
            {lessons.map((l) => (
              <li key={l.id}>
                <a href={`#/lessons/${encodeURIComponent(l.id)}`} className={l.stale ? "stale" : undefined}>
                  <span className="title">{l.title}</span>
                  {l.stale && <span className="tag">已失效</span>}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function ServiceLine({ label, status, okText }: { label: string; status: ServiceStatus | null; okText: string }) {
  if (!status) return <p>{label}：檢查中…</p>;
  const ok = status.configured && status.ok !== false;
  return (
    <p className={ok ? "ok" : "warn"}>
      {label}：{ok ? okText : (status.error?.message ?? "尚未設定")}
    </p>
  );
}
