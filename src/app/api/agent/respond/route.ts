import { resolveResponse, getCallAction } from "@/lib/agent/session";
import { patchAction, resolveActionByCall } from "@/lib/agent/action-log";
import type { AgentRespondBody, ToolClientResult } from "@/lib/agent/events";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/agent/respond — the client→server half of the agent channel.
//
// The browser answers tool_call_request (wallet execution results) and
// confirmation_request (approve/decline) here while the run's NDJSON stream
// stays open on the original request. The in-memory session registry resolves
// the parked promise; the loop continues.
//
// kind "tool_status" (Phase 3 §4.6): mid-flight transaction lifecycle
// transitions (requested/signed/broadcast/confirmed/rejected/timeout/unknown)
// reported while the tool call is STILL parked — each patches the persistent
// action-log row so the Actions/Wallet surfaces reflect live state instead of
// sitting at "running" until the final result lands.
// ─────────────────────────────────────────────────────────────────────────────

function actionStatusFor(status: string): string | null {
  switch (status) {
    case "requested":
      return "awaiting_signature";
    case "signed":
    case "broadcast":
      return "broadcast";
    case "confirmed":
      return "succeeded";
    case "rejected":
      return "declined";
    case "failed":
    case "timeout":
      return "failed";
    case "unknown":
      return "unknown";
    default:
      return null;
  }
}

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: AgentRespondBody;
  try {
    body = (await req.json()) as AgentRespondBody;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (!body?.sessionId || !body?.callId || !body?.kind) {
    return new Response(JSON.stringify({ error: "sessionId, callId and kind are required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (body.kind === "tool_result") {
    const result = body.result as ToolClientResult | undefined;
    if (!result || typeof result.ok !== "boolean" || typeof result.summary !== "string") {
      return new Response(JSON.stringify({ error: "result must be { ok, summary, … }" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const delivered = resolveResponse(body.sessionId, body.callId, result);
    return new Response(JSON.stringify({ delivered }), {
      status: delivered ? 200 : 409,
      headers: { "content-type": "application/json" },
    });
  }

  if (body.kind === "confirmation") {
    const delivered = resolveResponse(body.sessionId, body.callId, {
      approved: body.approved === true,
      rememberChoice: body.rememberChoice,
    });
    return new Response(JSON.stringify({ delivered }), {
      status: delivered ? 200 : 409,
      headers: { "content-type": "application/json" },
    });
  }

  if (body.kind === "tool_status") {
    const status = actionStatusFor(body.status);
    // A result payload rides ONLY the background receipt tracker's terminal
    // resolution (mid-flight transitions never carry one) — it patches the
    // row's outcome, not just its status.
    const resultPatch = body.result ? { result: body.result as Record<string, unknown> } : {};
    const bound = getCallAction(body.sessionId, body.callId);
    if (bound && status) {
      // Mid-flight status only: patch the row status + chain so the
      // Actions/Wallet surfaces reflect the live lifecycle. The tx hash and
      // full summary land with the final tool_result (the client's live
      // tx-lifecycle store carries the hash for instant UI in the meantime).
      patchAction(bound.actionId, {
        status,
        ...resultPatch,
        ...(body.chainId != null ? { chainId: body.chainId } : {}),
      });
      return new Response(JSON.stringify({ delivered: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (status && body.result) {
      // Run already over (session swept, or another serverless container):
      // the tracker's terminal resolution flips the action row by callId.
      // Gated on the result payload so a stale mid-flight ping can never
      // mutate a finished row.
      const resolved = resolveActionByCall(body.callId, status, {
        ...resultPatch,
        ...(body.chainId != null ? { chainId: body.chainId } : {}),
      });
      return new Response(JSON.stringify({ delivered: resolved }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    // No parked call and no resolvable row (late status after completion, or
    // a stale run) — the final tool_result is authoritative; nothing to patch.
    return new Response(JSON.stringify({ delivered: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ error: "kind must be tool_result, confirmation, or tool_status" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}
