// Microphone check for the settings page: permission plus a live volume meter. Nothing is recorded.

export type MicCheckError = "denied" | "no-device" | "unsupported" | "failed";

export interface MicMeter {
  stop(): void;
}

export async function startMicMeter(onLevel: (level: number) => void): Promise<MicMeter> {
  if (!navigator.mediaDevices?.getUserMedia) throw "unsupported" satisfies MicCheckError;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const name = (err as DOMException)?.name;
    throw (name === "NotAllowedError" || name === "SecurityError"
      ? "denied"
      : name === "NotFoundError" || name === "OverconstrainedError"
        ? "no-device"
        : "failed") satisfies MicCheckError;
  }
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  let frame = 0;
  const tick = () => {
    analyser.getByteTimeDomainData(samples);
    let peak = 0;
    for (const v of samples) peak = Math.max(peak, Math.abs(v - 128) / 128);
    onLevel(Math.min(1, peak * 1.5));
    frame = requestAnimationFrame(tick);
  };
  tick();
  return {
    stop() {
      cancelAnimationFrame(frame);
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}

export const MIC_ERROR_TEXT: Record<MicCheckError, string> = {
  denied: "麥克風權限被拒絕：請點網址列左側的鎖頭圖示，允許麥克風後重新整理頁面。仍可用打字上課。",
  "no-device": "找不到麥克風，請確認裝置已連接。仍可用打字上課。",
  unsupported: "這個瀏覽器無法使用麥克風，請改用 Chrome 或 Edge。仍可用打字上課。",
  failed: "無法開啟麥克風，請檢查裝置或其他程式是否占用。仍可用打字上課。",
};
