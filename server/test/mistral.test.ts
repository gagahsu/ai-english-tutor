import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { createMistralProvider } from "../src/llm/mistral.js";

type Step = Response | Error;

function setup(...steps: Step[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const logs: string[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const step = steps.shift();
    if (!step) throw new Error("no response queued");
    if (step instanceof Error) throw step;
    return step;
  }) as unknown as typeof globalThis.fetch;
  const llm = createMistralProvider({ apiKey: "test-key", model: "m-1", fetch, retryDelayMs: 0, log: (l) => logs.push(l) });
  return { llm, calls, logs };
}

const ok = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }), {
    status: 200,
  });
const status = (code: number, headers: Record<string, string> = {}) => new Response("{}", { status: code, headers });

const req = { messages: [{ role: "user" as const, content: "PRIVATE TRANSCRIPT" }], json: true, purpose: "turn" };

async function errorCode(p: Promise<unknown>) {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  return (err as AppError).code;
}

describe("Mistral provider", () => {
  it("sends a JSON-mode chat request and logs usage without content", async () => {
    const { llm, calls, logs } = setup(ok('{"a":1}'));
    expect(await llm.complete(req)).toEqual({ text: '{"a":1}' });

    expect(calls[0]!.url).toBe("https://api.mistral.ai/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      model: "m-1",
      response_format: { type: "json_object" },
      messages: req.messages,
    });
    expect(logs).toEqual([expect.stringMatching(/purpose=turn model=m-1 status=200 ms=\d+ tokens=12\+3/)]);
    expect(logs.join()).not.toContain("PRIVATE");
    expect(logs.join()).not.toContain("test-key");
  });

  it("retries a 5xx or a network failure up to twice", async () => {
    expect((await setup(status(503), ok("x")).llm.complete(req)).text).toBe("x");
    expect((await setup(new TypeError("fetch failed"), status(502), ok("y")).llm.complete(req)).text).toBe("y");
    const down = setup(new TypeError("a"), new TypeError("b"), new TypeError("c"));
    expect(await errorCode(down.llm.complete(req))).toBe("LLM_UNREACHABLE");
    expect(down.calls).toHaveLength(3);
  });

  it("retries a short rate limit up to twice, then reports it", async () => {
    expect((await setup(status(429, { "retry-after": "0" }), status(429), ok("z")).llm.complete(req)).text).toBe("z");
    const limited = setup(status(429), status(429), status(429));
    expect(await errorCode(limited.llm.complete(req))).toBe("LLM_RATE_LIMIT");
    expect(limited.calls).toHaveLength(3);
    const long = setup(status(429, { "retry-after": "60" }));
    expect(await errorCode(long.llm.complete(req))).toBe("LLM_RATE_LIMIT");
    expect(long.calls).toHaveLength(1);
  });

  it("explains a model with no quota on the plan instead of retrying", async () => {
    const s = setup(status(429, { "x-ratelimit-limit-req-minute": "0" }));
    expect(await errorCode(s.llm.complete(req))).toBe("LLM_MODEL_UNAVAILABLE");
    expect(s.calls).toHaveLength(1);
  });

  it("maps auth and other client errors", async () => {
    expect(await errorCode(setup(status(401)).llm.complete(req))).toBe("LLM_UNAUTHORIZED");
    expect(await errorCode(setup(status(400)).llm.complete(req))).toBe("LLM_ERROR");
  });
});
