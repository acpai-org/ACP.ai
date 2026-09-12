// Next.js server instrumentation — runs once per server process (dev + prod),
// in the Node.js runtime only.
//
// Boots the Attestcoin attestation poller, which watches settled payments for
// proofs appearing on the Creditcoin proof builder and fires "attested"
// notifications. See src/lib/attestcoin/poller.ts.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startAttestationPoller, pollOnce } = await import("@/lib/attestcoin/poller");
  const { ensureSourceChainMapFresh } = await import("@/lib/attestcoin/chains");
  const { ensureDb } = await import("@/db");
  startAttestationPoller();
  // P3/N5 warm-up (fire-and-forget): apply the DB schema and warm the live
  // chain map NOW so the first API request doesn't pay ensureDb()'s DDL plus a
  // cold chain-info eth_call, and run one immediate poll pass so fresh
  // attestations don't wait for the first 60s interval tick.
  try {
    ensureDb();
  } catch (err) {
    console.error("[instrumentation] ensureDb warm-up failed:", err);
  }
  void ensureSourceChainMapFresh().catch(() => {});
  void pollOnce().catch(() => {});
}
