import type { z } from "zod";
import type { CompletionRequest, LlmProvider } from "./provider.js";

export type StructuredResult<T> = { ok: true; value: T } | { ok: false; raw: string };

/**
 * Asks for JSON matching `schema`. Invalid output gets one retry that shows the model its
 * mistake; a second failure returns the raw text so the caller can degrade (SRS §8).
 * Provider errors (rate limit, network) propagate.
 */
export async function completeStructured<S extends z.ZodType>(
  llm: LlmProvider,
  req: CompletionRequest,
  schema: S,
): Promise<StructuredResult<z.output<S>>> {
  let messages = req.messages;
  let raw = "";
  for (let tries = 1; tries <= 2; tries++) {
    raw = (await llm.complete({ ...req, messages, json: true })).text;
    const problem = check(raw, schema);
    if (problem.ok) return problem;
    messages = [
      ...req.messages,
      { role: "assistant", content: raw },
      {
        role: "user",
        content: `Your reply was not valid for the required JSON format (${problem.reason}). Reply again with only the corrected JSON object.`,
      },
    ];
  }
  return { ok: false, raw };
}

function check<S extends z.ZodType>(raw: string, schema: S): { ok: true; value: z.output<S> } | { ok: false; reason: string } {
  let data: unknown;
  try {
    data = JSON.parse(stripFences(raw));
  } catch {
    return { ok: false, reason: "not parseable JSON" };
  }
  const parsed = schema.safeParse(dropEmpty(data));
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  return { ok: false, reason: issues.join("; ") };
}

const stripFences = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

/** Models often send "" or null for optional fields; treat those as absent. */
function dropEmpty(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropEmpty);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null && !(typeof v === "string" && v.trim() === ""))
        .map(([k, v]) => [k, dropEmpty(v)]),
    );
  }
  return value;
}
