import { fireRecurringSchedule } from "@/lib/recurring/fire";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/recurring/[id]/fire — the recurring-executor seam (brief §5).
// The client poller (or the "Run now" button) calls this when a schedule is
// due (app open + wallet connected). All ledger semantics — atomic claim,
// catch-up advance, completion, action-log row — live in lib/recurring/fire.ts.
// The route returns the schedule + pre-fire state so the client can requeue
// if the subsequent agent dispatch loses a race with a busy run.
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  const { id } = await params;

  let bodyStatus = "fired";
  try {
    const body = (await req.json().catch(() => ({}))) as { status?: unknown };
    if (typeof body.status === "string" && body.status.length > 0) bodyStatus = body.status;
  } catch {
    // no body — default status
  }

  const outcome = fireRecurringSchedule(id, bodyStatus);
  if (!outcome.ok) {
    return new Response(JSON.stringify({ error: outcome.error }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify(
      outcome.skipped
        ? { ok: true, skipped: true, reason: outcome.reason, schedule: outcome.schedule }
        : { ok: true, skipped: false, schedule: outcome.schedule, previous: outcome.previous, firedAt: outcome.firedAt },
    ),
    { headers: { "content-type": "application/json" } },
  );
}
