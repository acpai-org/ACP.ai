import { getDeployPolicy, updateDeployPolicy, type DeployPolicy } from "@/lib/agent/policy";

// ─────────────────────────────────────────────────────────────────────────────
// /api/agent/policy — deploy policy management (Phase 3).
//   GET  → { policy: { mainnetDeployOptIn, dismissedCustomDeployWarning } }
//   POST → { action: "update", patch: { mainnetDeployOptIn?: boolean } }
//        | { action: "dismiss-custom-warning" }
// The session mandate API was removed with the mandate feature (C26); only
// the deploy-related per-user preferences remain.
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";

export async function GET() {
  return new Response(JSON.stringify({ policy: getDeployPolicy() }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function POST(req: Request) {
  let body: { action?: string; patch?: Partial<DeployPolicy> };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }

  if (body.action === "update") {
    const patch = body.patch ?? {};
    const safe: Partial<DeployPolicy> = {};
    if (typeof patch.mainnetDeployOptIn === "boolean") safe.mainnetDeployOptIn = patch.mainnetDeployOptIn;
    if (Object.keys(safe).length === 0) {
      return new Response(JSON.stringify({ error: "patch must include mainnetDeployOptIn (boolean)" }), { status: 400 });
    }
    const policy = updateDeployPolicy(safe);
    return new Response(JSON.stringify({ ok: true, policy }), { headers: { "content-type": "application/json" } });
  }

  if (body.action === "dismiss-custom-warning") {
    updateDeployPolicy({ dismissedCustomDeployWarning: true });
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  }

  return new Response(JSON.stringify({ error: "action must be update or dismiss-custom-warning" }), { status: 400 });
}
