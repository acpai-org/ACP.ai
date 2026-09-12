import { runAgentLoop } from "@/lib/agent/loop";
import { sweepSessions } from "@/lib/agent/session";
import type { AgentStreamEvent } from "@/lib/agent/events";
import type { WalletContext } from "@/lib/ai/system-prompt";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/agent/run — one agent run over the NDJSON streaming channel.
//
// The stream stays open for the WHOLE run: text deltas, live trace steps,
// tool_call_request dispatches and confirmation prompts all ride it, while the
// browser answers on POST /api/agent/respond (the session registry bridges the
// two requests). Browser disconnect aborts the run: pending steps are marked
// interrupted in the action log (on-chain transactions complete independently).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";
export const maxDuration = 300;

interface IncomingMessage {
  role: "user" | "assistant";
  content: string;
  /** P10 retry context: prior assistant tool calls (id/name/args). */
  toolCalls?: Array<{ id?: unknown; name?: unknown; args?: unknown }>;
  /** P10 retry context: this entry is a prior tool RESULT (id + name). */
  toolCallId?: string;
  toolName?: string;
}

interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number | null;
}

export async function POST(req: Request) {
  let body: {
    sessionId?: string;
    messages?: IncomingMessage[];
    providerConfig?: ProviderConfig;
    wallet?: WalletContext | null;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body", code: "bad-request" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const sessionId =
    body.sessionId && /^[A-Za-z0-9_-]{4,64}$/.test(body.sessionId) ? body.sessionId : `s_${Date.now().toString(36)}`;
  const messages = (body.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => {
      // P10: normalize the extended history fields (drop malformed entries
      // defensively — the loop re-validates shapes on its side too).
      const toolCalls = Array.isArray(m.toolCalls)
        ? m.toolCalls
            .filter(
              (c): c is { id: string; name: string; args: Record<string, unknown> } =>
                typeof c?.id === "string" &&
                typeof c?.name === "string" &&
                c.args != null &&
                typeof c.args === "object",
            )
            .map((c) => ({ id: c.id, name: c.name, args: c.args as Record<string, unknown> }))
        : undefined;
      return {
        role: m.role,
        content: m.content,
        ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
        ...(typeof m.toolCallId === "string" && typeof m.toolName === "string"
          ? { toolCallId: m.toolCallId, toolName: m.toolName }
          : {}),
      };
    });
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return new Response(JSON.stringify({ error: "messages must end with a user message", code: "bad-request" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const providerConfig = body.providerConfig ?? {};

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      // L8 fix: capture the runId from the loop's first event so the abort
      // sweep is RUN-SCOPED. The old sweepInterrupted() flipped the 30 newest
      // non-terminal actions FROM ANY SESSION — a second tab's in-flight
      // transfer got marked interrupted while its wallet prompt was still up,
      // and (because `listActions(30)` is a ROW limit, not a time window)
      // rows beyond the 30 newest escaped the sweep and spun "running"
      // forever. The run-scoped interruptRunningActions(runId) existed but was
      // dead code.
      let runId: string | null = null;
      const send = (evt: AgentStreamEvent) => {
        if (evt.type === "run_started" && typeof evt.runId === "string") runId = evt.runId;
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(evt) + "\n"));
        } catch {
          closed = true;
        }
      };

      console.log("[agent] run started:", {
        sessionId,
        provider: providerConfig.baseUrl || "https://api.openai.com/v1",
        model: providerConfig.model,
        messageCount: messages.length,
        lastUserMessage: messages[messages.length - 1]?.content.slice(0, 120),
      });

      try {
        await runAgentLoop({
          sessionId,
          messages,
          wallet: body.wallet ?? null,
          providerConfig,
          emit: send,
          signal: req.signal,
        });
      } catch (err) {
        console.error("[agent] run crashed:", err);
        try {
          send({ type: "error", error: err instanceof Error ? err.message : "agent run failed" });
        } catch {}
      } finally {
        if (req.signal.aborted && runId) {
          // L8: run-scoped interrupt — only THIS run's non-terminal rows flip
          // to interrupted; broadcast rows keep their honest status.
          try {
            const { interruptRunningActions } = await import("@/lib/agent/action-log");
            interruptRunningActions(runId);
          } catch {
            // non-critical
          }
        }
        closed = true;
        try {
          controller.close();
        } catch {}
        sweepSessions();
      }
    },
    cancel() {
      // Reader cancelled — req.signal also fires (the loop relies on that).
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-acp-session": sessionId,
      connection: "keep-alive",
    },
  });
}
