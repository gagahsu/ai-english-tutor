import type { SessionSummary } from "../api";

/** After-class review (FR-11): summary, corrections, better phrasing, vocabulary, next steps. */
export function SummaryView({ summary, onRetry, retrying }: { summary: SessionSummary; onRetry?: () => void; retrying?: boolean }) {
  return (
    <section className="summary" aria-label="課後摘要">
      <h2>課後摘要</h2>
      <p className="overview">{summary.overviewZh}</p>
      <p className="hint">
        回答 {summary.stats.answers} 次・中文協助 {summary.stats.chineseHelp} 次・可改進 {summary.stats.corrections} 處
        {summary.sectionsCovered.length > 0 && <>・章節：{summary.sectionsCovered.map((s) => s.title).join("、")}</>}
      </p>
      {summary.degraded && (
        <p className="notice">
          AI 老師當時無法產生完整回顧，以下是依紀錄整理的版本。
          {onRetry && (
            <button type="button" className="link" onClick={onRetry} disabled={retrying}>
              {retrying ? "重新產生中…" : "重新產生"}
            </button>
          )}
        </p>
      )}

      {summary.corrections.length > 0 && (
        <>
          <h3>文法與用字修正</h3>
          <ul className="summary-list">
            {summary.corrections.map((c, i) => (
              <li key={i} className="correction">
                <span className="from" lang="en">
                  {c.original}
                </span>{" "}
                →{" "}
                <span className="to" lang="en">
                  {c.suggestion}
                </span>
                {c.reasonZh && <span className="why">（{c.reasonZh}）</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {summary.naturalExpressions.length > 0 && (
        <>
          <h3>更自然的說法</h3>
          <ul className="summary-list">
            {summary.naturalExpressions.map((e, i) => (
              <li key={i}>
                <span className="muted" lang="en">
                  {e.original}
                </span>{" "}
                →{" "}
                <strong lang="en">{e.better}</strong>
                {e.noteZh && <span className="zh"> {e.noteZh}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {summary.phrases.length > 0 && (
        <>
          <h3>老師教的說法</h3>
          <ul className="summary-list">
            {summary.phrases.map((p, i) => (
              <li key={i}>
                <strong lang="en">{p.english}</strong>
                {p.zhExplanation && <span className="zh"> {p.zhExplanation}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {summary.vocabulary.length > 0 && (
        <>
          <h3>字彙</h3>
          <ul className="summary-vocab">
            {summary.vocabulary.map((v) => (
              <li key={v.term}>
                <span lang="en">{v.term}</span>
                {v.meaningZh && <span className="zh">{v.meaningZh}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {summary.nextSteps.length > 0 && (
        <>
          <h3>下次練習建議</h3>
          <ol className="summary-list">
            {summary.nextSteps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
