// Text-to-speech through the browser's speechSynthesis, with an English voice (SRS §5, FR-07).

export class TtsError extends Error {}

export interface TtsEngine {
  readonly supported: boolean;
  /** Resolves when speech ends or is cancelled; rejects with TtsError when it cannot play. */
  speak(text: string, rate: number): Promise<void>;
  pause(): void;
  resume(): void;
  cancel(): void;
  /** English voices this browser offers, best first. */
  voices(): Promise<SpeechSynthesisVoice[]>;
}

// Chrome cuts off long utterances, so speech is queued sentence by sentence.
const MAX_CHUNK = 180;
// If speech has not started by then, assume the browser will not play it.
const START_TIMEOUT_MS = 4_000;
const VOICES_TIMEOUT_MS = 1_500;

/** The teacher speaks English; Chinese in a reply is shown on screen but never read aloud (SRS §4.4). */
export function speakableEnglish(text: string): string {
  return text
    .replace(/[\p{Script=Han}　-〿＀-￯]+/gu, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function chunks(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const last = out.at(-1);
    if (last && last.length + sentence.length + 1 <= MAX_CHUNK) out[out.length - 1] = `${last} ${sentence}`;
    else out.push(sentence);
  }
  return out.filter((c) => c.trim());
}

export function createBrowserTts(win: Window = window): TtsEngine {
  const synth = win.speechSynthesis as SpeechSynthesis | undefined;
  const Utterance = (win as unknown as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance }).SpeechSynthesisUtterance;
  let generation = 0;

  async function voices(): Promise<SpeechSynthesisVoice[]> {
    if (!synth) return [];
    let list = synth.getVoices();
    if (!list.length) {
      // Chrome loads voices asynchronously.
      list = await new Promise((resolve) => {
        const done = () => resolve(synth.getVoices());
        synth.addEventListener("voiceschanged", done, { once: true });
        setTimeout(done, VOICES_TIMEOUT_MS);
      });
    }
    const english = list.filter((v) => v.lang.toLowerCase().startsWith("en"));
    const score = (v: SpeechSynthesisVoice) =>
      (v.lang === "en-US" ? 4 : 0) + (/natural|online|google/i.test(v.name) ? 2 : 0) + (v.localService ? 0 : 1);
    return english.sort((a, b) => score(b) - score(a));
  }

  return {
    supported: !!synth && !!Utterance,
    voices,
    async speak(text, rate) {
      if (!synth || !Utterance) throw new TtsError("這個瀏覽器不支援語音朗讀，老師的話會以文字顯示。");
      const voice = (await voices())[0];
      if (!voice) throw new TtsError("找不到英文語音，老師的話會以文字顯示；可在系統設定安裝英文語音。");
      synth.cancel();
      const mine = ++generation;
      for (const part of chunks(speakableEnglish(text))) {
        if (mine !== generation) return;
        await new Promise<void>((resolve, reject) => {
          const u = new Utterance(part);
          u.voice = voice;
          u.lang = voice.lang;
          u.rate = rate;
          let started = false;
          const watchdog = setTimeout(() => {
            if (!started && !synth.paused) {
              synth.cancel();
              reject(new TtsError("瀏覽器沒有播放語音，老師的話會以文字顯示；可按「重播」再試。"));
            }
          }, START_TIMEOUT_MS);
          u.onstart = () => {
            started = true;
          };
          u.onend = () => {
            clearTimeout(watchdog);
            resolve();
          };
          u.onerror = (e) => {
            clearTimeout(watchdog);
            // A cancel (stop, replay, a new reply) is not a failure.
            if (e.error === "canceled" || e.error === "interrupted") resolve();
            else reject(new TtsError("語音朗讀失敗，老師的話會以文字顯示；可按「重播」再試。"));
          };
          synth.speak(u);
        });
      }
    },
    pause: () => synth?.pause(),
    resume: () => synth?.resume(),
    cancel() {
      generation++;
      synth?.cancel();
    },
  };
}
