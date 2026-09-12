import type { LlmAdapter, LlmCallInput, LlmCallResult, ToolCallRequest } from "./types";
import { LlmError } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Chat Completions agent adapter (server-side; user's BYOK key arrives
// per-request and is never persisted).
//
// Built on the researched-current surface (2026-09-04): Chat Completions with
// native `tools` is the interoperable agent-loop standard — supported by
// OpenAI itself (not deprecated) and by every OpenAI-compatible provider the
// app supports (DeepSeek, Kimi, Ollama, xAI, Groq). Tool definitions use the
// nested `function{}` shape; parallel calls arrive as multiple
// choices[0].message.tool_calls entries; streaming tool_calls deltas arrive
// keyed by `index` with id/name only on the FIRST delta of each call.
//
// The Responses API is OpenAI-host-only and cannot serve the BYOK multi-
// provider surface; CC `tools` is the deliberate choice (worklog P2-1).
// ─────────────────────────────────────────────────────────────────────────────

export interface OpenAiAdapterConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number | null;
}

interface ChatMessageWire {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}${path}`;
}

/** Reasoning models consume output budget on hidden reasoning — enlarge it. */
function resolveMaxTokens(model: string, configured?: number | null): number | undefined {
  const m = model.toLowerCase();
  const reasoning = /^o[0-9]/.test(m) || /o1-mini|o3-mini|o4-mini/.test(m) || /reason/.test(m) || /deepseek-r/.test(m);
  if (reasoning) return Math.max(configured ?? 0, 16000);
  return configured ?? undefined;
}

interface WireChoiceDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string | null;
    type?: string | null;
    function?: { name?: string | null; arguments?: string | null };
  }>;
}

interface WireChunk {
  choices?: Array<{
    delta?: WireChoiceDelta;
    message?: WireChoiceDelta & { finish_reason?: string | null };
    finish_reason?: string | null;
  }>;
  error?: { message?: string; code?: string };
}

function toWireMessages(system: string, messages: LlmCallInput["messages"]): ChatMessageWire[] {
  const wire: ChatMessageWire[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      wire.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const entry: ChatMessageWire = { role: "assistant", content: m.content || "" };
      if (m.toolCalls && m.toolCalls.length > 0) {
        entry.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: c.argsJson || "{}" },
        }));
        // OpenAI requires non-null content for assistant messages with tool_calls.
        entry.content = m.content || "";
      }
      wire.push(entry);
    } else if (m.role === "tool") {
      wire.push({ role: "tool", content: m.content, tool_call_id: m.toolCallId });
    }
  }
  return wire;
}

/** Parse an error body into an LlmError with the right code. */
async function httpError(res: Response, preloadedText?: string): Promise<LlmError> {
  let detail = preloadedText ?? "";
  if (!detail) {
    try {
      detail = await res.text();
    } catch {
      detail = "";
    }
  }
  if (detail) {
    try {
      const parsed = JSON.parse(detail) as { error?: { message?: string } };
      detail = parsed.error?.message ?? detail.slice(0, 400);
    } catch {
      detail = detail.slice(0, 400);
    }
  }
  const code = res.status === 401 || res.status === 403 ? "auth" : res.status === 429 ? "rate-limit" : "llm-http";
  return new LlmError(`AI endpoint error ${res.status}: ${detail || res.statusText}`, res.status, code);
}

/** POST the chat body; network-layer failures become LlmError("network"). */
async function postChat(url: string, apiKey: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw new LlmError(`Could not reach the AI endpoint (${url}): ${err instanceof Error ? err.message : String(err)}`, undefined, "network");
  }
}

/** Consume the SSE response body and accumulate content + tool calls. */
async function consumeSseStream(res: Response, input: LlmCallInput): Promise<LlmCallResult> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason = "";
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();

  const pushDelta = (delta: WireChoiceDelta) => {
    if (typeof delta.content === "string" && delta.content.length > 0) {
      content += delta.content;
      input.onTextDelta?.(delta.content);
    }
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      input.onReasoningDelta?.(delta.reasoning_content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === "number" ? tc.index : toolAcc.size;
        let acc = toolAcc.get(idx);
        if (!acc) {
          acc = { id: "", name: "", args: "" };
          toolAcc.set(idx, acc);
        }
        if (typeof tc.id === "string" && tc.id) acc.id = acc.id || tc.id;
        if (tc.function?.name) acc.name = acc.name || tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const rawLine = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!rawLine || rawLine.startsWith(":")) continue; // SSE comment/heartbeat
        if (!rawLine.startsWith("data:")) continue;
        const payload = rawLine.slice(5).trim();
        if (payload === "[DONE]") continue;
        let chunk: WireChunk;
        try {
          chunk = JSON.parse(payload) as WireChunk;
        } catch {
          continue; // tolerate keep-alive garbage
        }
        if (chunk.error?.message) {
          throw new LlmError(chunk.error.message, undefined, "llm-stream");
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.delta) pushDelta(choice.delta);
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  const toolCalls: ToolCallRequest[] = [];
  for (const [idx, acc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!acc.name) continue; // malformed — skip
    toolCalls.push({
      id: acc.id || `call_${idx}_${Date.now().toString(36)}`,
      name: acc.name,
      argsJson: acc.args || "{}",
    });
  }

  return { content, toolCalls, finishReason: finishReason || "stop" };
}

export function createOpenAiAdapter(config: OpenAiAdapterConfig): LlmAdapter {
  const url = joinUrl(config.baseUrl, "/chat/completions");
  const maxTokens = resolveMaxTokens(config.model, config.maxTokens);

  return {
    id: "openai-completions",

    async chat(input: LlmCallInput): Promise<LlmCallResult> {
      // F2 (ordering fix): parallel_tool_calls:false asks the provider to emit
      // AT MOST ONE tool call per assistant message — the narrate→tool→narrate
      // interleave the product promises. Providers that ignore the flag are
      // covered by the loop-side guard (only the first call of a batch runs;
      // the rest get corrective tool-role feedback). Providers that REJECT the
      // unknown field (some OpenAI-compatible servers 400 on it) get one
      // automatic retry without it — see the 400 handling below.
      const body: Record<string, unknown> = {
        model: config.model,
        messages: toWireMessages(input.system, input.messages),
        tools: input.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        tool_choice: "auto",
        parallel_tool_calls: false,
        stream: true,
      };
      if (typeof config.temperature === "number") body.temperature = config.temperature;
      if (typeof config.topP === "number") body.top_p = config.topP;
      if (typeof maxTokens === "number") body.max_tokens = maxTokens;

      let res = await postChat(url, config.apiKey, body, input.signal);

      // F2 compat: a 400 that names the flag (or an unrecognized-parameter
      // complaint naming it) means this provider doesn't know the field —
      // retry ONCE without it. The loop-side guard keeps the ordering
      // contract even when the provider still batches calls.
      if (res.status === 400) {
        const errText = await res.text().catch(() => "");
        if (/parallel_tool_calls/i.test(errText) || /unrecognized|unknown\s+(parameter|argument|field)/i.test(errText)) {
          const retryBody: Record<string, unknown> = { ...body };
          delete retryBody.parallel_tool_calls;
          res = await postChat(url, config.apiKey, retryBody, input.signal);
        } else {
          throw await httpError(res, errText);
        }
      }

      if (!res.ok || !res.body) {
        throw await httpError(res);
      }
      return consumeSseStream(res, input);
    },
  };
}
