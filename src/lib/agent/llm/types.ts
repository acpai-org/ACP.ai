// ─────────────────────────────────────────────────────────────────────────────
// Provider-neutral LLM interface for the agent loop (brief §2).
//
// One implementation:
//  - openai.ts: OpenAI Chat Completions API with native `tools` — the agent
//    backend. Works with api.openai.com AND every OpenAI-compatible BYOK
//    endpoint (DeepSeek, Kimi, Ollama, xAI, Groq…). The user configures the
//    endpoint + key in Settings; there is no built-in provider (C27).
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolCallRequest {
  id: string;
  name: string;
  /** Raw JSON arguments string from the model (validated downstream by zod). */
  argsJson: string;
}

export interface LlmAssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: ToolCallRequest[];
}

export interface LlmToolResultMessage {
  role: "tool";
  toolCallId: string;
  toolName: string;
  content: string;
}

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | LlmAssistantMessage
  | LlmToolResultMessage;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmCallInput {
  system: string;
  messages: LlmMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  /** Streaming text callback (typed char-groups while the model writes). */
  onTextDelta?: (text: string) => void;
  /** Optional reasoning-delta callback (models that expose thinking). */
  onReasoningDelta?: (text: string) => void;
}

export interface LlmCallResult {
  content: string;
  toolCalls: ToolCallRequest[];
  finishReason: string;
}

export interface LlmAdapter {
  readonly id: string;
  chat(input: LlmCallInput): Promise<LlmCallResult>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code: string = "llm-error",
  ) {
    super(message);
    this.name = "LlmError";
  }
}
