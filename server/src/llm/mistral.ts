import {
  AppError,
  llmError,
  llmModelUnavailable,
  llmRateLimited,
  llmUnauthorized,
  llmUnreachable,
} from "../errors.js";
import type { CompletionRequest, LlmProvider } from "./provider.js";

export interface MistralOptions {
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Base backoff before retrying a timeout, 5xx or 429; doubles per attempt (a short Retry-After wins). */
  retryDelayMs?: number;
  /** Receives one non-sensitive line per request (NFR-06): model, status, latency, tokens. */
  log?: (line: string) => void;
}

const ENDPOINT = "https://api.mistral.ai/v1/chat/completions";
const MAX_RETRY_AFTER_MS = 5_000;
// The free tier sometimes answers 429 with no quota headers even when the per-minute quota is
// far from used; it clears within a few seconds, so allow two retries before giving up.
const MAX_ATTEMPTS = 3;

export function createMistralProvider({
  apiKey,
  model,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  retryDelayMs = 1_500,
  log = (line) => console.info(line),
}: MistralOptions): LlmProvider {
  async function attempt(req: CompletionRequest): Promise<Response> {
    return fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: req.messages,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        ...(req.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  return {
    model,
    async complete(req) {
      for (let tries = 1; ; tries++) {
        const started = Date.now();
        let res: Response;
        try {
          res = await attempt(req);
        } catch {
          log(`[llm] purpose=${req.purpose} model=${model} error=network ms=${Date.now() - started}`);
          if (tries < MAX_ATTEMPTS) {
            await sleep(retryDelayMs * 2 ** (tries - 1));
            continue;
          }
          throw llmUnreachable();
        }

        if (res.ok) {
          const body = (await res.json()) as MistralResponse;
          const u = body.usage;
          log(
            `[llm] purpose=${req.purpose} model=${model} status=200 ms=${Date.now() - started}` +
              ` tokens=${u?.prompt_tokens ?? "?"}+${u?.completion_tokens ?? "?"}`,
          );
          return { text: body.choices?.[0]?.message?.content ?? "" };
        }

        log(`[llm] purpose=${req.purpose} model=${model} status=${res.status} ms=${Date.now() - started}`);
        const err = toAppError(res, model);
        const retryAfter = Number(res.headers.get("retry-after")) * 1000;
        const retryable =
          res.status >= 500 || (err.code === "LLM_RATE_LIMIT" && !(retryAfter > MAX_RETRY_AFTER_MS));
        if (tries < MAX_ATTEMPTS && retryable) {
          await sleep(retryAfter > 0 ? retryAfter : retryDelayMs * 2 ** (tries - 1));
          continue;
        }
        throw err;
      }
    },
  };
}

interface MistralResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function toAppError(res: Response, model: string): AppError {
  if (res.status === 401 || res.status === 403) return llmUnauthorized();
  if (res.status === 429) {
    // A per-minute limit of 0 means the plan has no quota for this model at all.
    return res.headers.get("x-ratelimit-limit-req-minute") === "0" ? llmModelUnavailable(model) : llmRateLimited();
  }
  if (res.status >= 500) return llmUnreachable();
  return llmError(res.status);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
