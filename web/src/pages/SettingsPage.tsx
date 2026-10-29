import { useEffect, useRef, useState } from "react";
import { ApiError, type Settings } from "../api";
import { useDeps } from "../deps";
import { MIC_ERROR_TEXT, startMicMeter, type MicCheckError, type MicMeter } from "../voice/mic";

const LEVELS: Settings["studentLevel"][] = ["A1", "A2", "B1", "B2", "C1", "C2"];

export function SettingsPage() {
  const { api, stt, tts } = useDeps();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then(setSettings, (err) => setMessage(err instanceof ApiError ? err.message : "無法載入設定。"));
  }, [api]);

  async function save(patch: Partial<Settings>) {
    setSettings((s) => (s ? { ...s, ...patch } : s));
    try {
      setSettings(await api.updateSettings(patch));
      setMessage("已儲存");
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "儲存失敗。");
    }
  }

  return (
    <main className="page">
      <header className="page-header stacked">
        <a href="#/">← 課程列表</a>
        <h1>設定與裝置檢查</h1>
      </header>
      {message && <p role="status">{message}</p>}

      {settings && (
        <section className="settings">
          <h2>教學設定</h2>
          <p>
            糾錯方式：Balanced（只當場糾正影響溝通的錯，其他留到課後）
            <br />
            老師語言：英文
          </p>
          <label>
            程度
            <select value={settings.studentLevel} onChange={(e) => save({ studentLevel: e.target.value as Settings["studentLevel"] })}>
              {LEVELS.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </label>
          <label>
            老師語速：{settings.speechRate.toFixed(1)}（1.0 為正常）
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.1}
              value={settings.speechRate}
              onChange={(e) => setSettings({ ...settings, speechRate: Number(e.target.value) })}
              onPointerUp={(e) => save({ speechRate: Number((e.target as HTMLInputElement).value) })}
              onKeyUp={(e) => save({ speechRate: Number((e.target as HTMLInputElement).value) })}
            />
          </label>
          <label>
            預設辨識語言
            <select value={settings.sttLanguage} onChange={(e) => save({ sttLanguage: e.target.value as Settings["sttLanguage"] })}>
              <option value="en-US">English（en-US）</option>
              <option value="zh-TW">中文（zh-TW）</option>
            </select>
          </label>
        </section>
      )}

      <section className="devices">
        <h2>裝置檢查</h2>
        <MicCheck />
        <p>
          語音辨識：
          {stt.supported ? "這個瀏覽器支援（英文／中文需手動切換）。" : "這個瀏覽器不支援，上課時請用打字回答；建議改用 Chrome 或 Edge。"}
        </p>
        <VoiceCheck rate={settings?.speechRate ?? 1} supported={tts.supported} />
      </section>

      <section className="privacy">
        <h2>隱私與資料傳輸</h2>
        <ul>
          <li>網站不會錄下或保存你的聲音，只保存文字回答與糾錯紀錄。</li>
          <li>語音辨識由瀏覽器提供；Chrome 會傳到 Google、Edge 會傳到 Microsoft 的雲端辨識。</li>
          <li>你的文字回答與課程教材（含 Notion 筆記裡的個人內容）會傳給 Mistral 產生老師回覆。</li>
          <li>API 金鑰只存在伺服器，不會出現在瀏覽器。</li>
        </ul>
      </section>
    </main>
  );
}

function MicCheck() {
  const [level, setLevel] = useState(0);
  const [state, setState] = useState<"off" | "on" | MicCheckError>("off");
  const meter = useRef<MicMeter | null>(null);
  useEffect(() => () => meter.current?.stop(), []);

  async function toggle() {
    if (meter.current) {
      meter.current.stop();
      meter.current = null;
      setState("off");
      setLevel(0);
      return;
    }
    try {
      meter.current = await startMicMeter(setLevel);
      setState("on");
    } catch (err) {
      setState(err as MicCheckError);
    }
  }

  return (
    <div className="mic-check">
      <button type="button" onClick={toggle}>
        {state === "on" ? "停止麥克風測試" : "測試麥克風"}
      </button>
      {state === "on" && (
        <>
          <meter min={0} max={1} value={level} aria-label="麥克風音量" />
          <span className="hint">對麥克風說話，音量條應該會跳動（不會錄音）。</span>
        </>
      )}
      {state !== "on" && state !== "off" && (
        <p className="error" role="alert">
          {MIC_ERROR_TEXT[state]}
        </p>
      )}
    </div>
  );
}

function VoiceCheck({ rate, supported }: { rate: number; supported: boolean }) {
  const { tts } = useDeps();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (supported) tts.voices().then(setVoices, () => setVoices([]));
  }, [supported, tts]);

  if (!supported) return <p>語音朗讀：這個瀏覽器不支援，老師的話會以文字顯示。</p>;
  return (
    <div className="voice-check">
      <p>
        語音朗讀：
        {voices === null ? "檢查中…" : voices.length ? `會使用「${voices[0]!.name}」（共 ${voices.length} 個英文語音）` : "找不到英文語音，老師的話會以文字顯示。"}
      </p>
      <button
        type="button"
        disabled={!voices?.length}
        onClick={() => {
          setError(null);
          tts.speak("Hello! I'm your English teacher. Can you hear me clearly?", rate).catch((e: Error) => setError(e.message));
        }}
      >
        播放測試語音
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
