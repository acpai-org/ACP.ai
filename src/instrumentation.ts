// Next.js server instrumentation — runs once per server process (dev + prod),
// in the Node.js runtime only.
//
// Boots the Attestcoin attestation poller, which watches settled payments for
// proofs appearing on the Creditcoin proof builder and fires "attested"
// notifications. See src/lib/attestcoin/poller.ts.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startAttestationPoller } = await import("@/lib/attestcoin/poller");
  startAttestationPoller();
}
