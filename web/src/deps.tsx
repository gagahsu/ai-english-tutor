import { createContext, useContext, useMemo, type ReactNode } from "react";
import { api } from "./api";
import { createBrowserStt, type SttEngine } from "./voice/stt";
import { createBrowserTts, type TtsEngine } from "./voice/tts";

/** Everything with side effects the UI talks to; tests provide fakes. */
export interface Deps {
  api: typeof api;
  stt: SttEngine;
  tts: TtsEngine;
}

const DepsContext = createContext<Deps | null>(null);

export function DepsProvider({ deps, children }: { deps?: Deps; children: ReactNode }) {
  const value = useMemo(() => deps ?? { api, stt: createBrowserStt(), tts: createBrowserTts() }, [deps]);
  return <DepsContext.Provider value={value}>{children}</DepsContext.Provider>;
}

export function useDeps(): Deps {
  const deps = useContext(DepsContext);
  if (!deps) throw new Error("useDeps outside DepsProvider");
  return deps;
}
