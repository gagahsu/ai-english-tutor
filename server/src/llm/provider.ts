export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  /** Ask the provider for a JSON object (the caller still validates it). */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Short label for usage logs, e.g. "turn" or "extract"; never the content itself. */
  purpose: string;
}

export interface CompletionResult {
  text: string;
}

/**
 * The only interface the app uses to reach an LLM, so the vendor can be swapped (SRS §7).
 * Implementations throw AppError (LLM_*) with zh-TW guidance on failure.
 */
export interface LlmProvider {
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}
