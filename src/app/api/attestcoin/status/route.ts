import { NextResponse } from "next/server";
import { getAttestcoinStatus } from "@/lib/attestcoin/status";
import { attestcoinEndpoints } from "@/lib/attestcoin/config";
import { getPollerStats } from "@/lib/attestcoin/poller";
import { submissionAvailability } from "@/lib/attestcoin/submit";

export const dynamic = "force-dynamic";

/**
 * Live Attestcoin Protocol network status: the Creditcoin block height plus,
 * per supported source chain, the latest attested height/hash and the lag
 * against the source chain head. Cached in memory for 30s.
 * `?force=1` bypasses the cache.
 *
 * The response also carries `poller` (server-side attestation watcher
 * liveness: how many payments it is watching, last tick, flips so far) and
 * `submission` (whether on-chain proof submission is enabled via
 * CREDITCOIN_SIGNER_KEY).
 */
export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("force") === "1";
  try {
    const status = await getAttestcoinStatus(force);
    return NextResponse.json({
      ...status,
      endpoints: {
        rpc: attestcoinEndpoints().rpcUrl,
        proofBuilder: attestcoinEndpoints().proofBuilderUrl,
        dashboard: attestcoinEndpoints().dashboardUrl,
      },
      poller: getPollerStats(),
      submission: submissionAvailability(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "attestcoin status unavailable", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
