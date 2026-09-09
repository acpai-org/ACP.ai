---
url: "https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation"
title: "Step 1: Attestation | Attestcoin"
---

For the complete documentation index, see [llms.txt](https://docs.attestcoin.org/llms.txt). This page is also available as [Markdown](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation.md).

## **Introduction**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation\#introduction)

Attestation is the process by which the Attestcoin Protocol keeps track of the confirmed state of source chains. This is the first of two critical steps for Attestcoin Protocol's readability process.

State transitions of each source chain are monitored by a decentralized network of attestors. Each eligible attestor creates an attestation, a cryptographic commitment showing its view of new blocks on the source chain and signs it with a BLS signature.

Since no single attestor can be fully trusted, we require consensus among independent attestors, achieved through a P2P gossip network that aggregates votes and signatures offline before submitting them on Creditcoin.

## **Attestation Process**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation\#attestation-process)

The attestation process is outlined below:

1. Attestors constantly monitor the source chain for new finalized blocks.

2. Periodically, Attestors summarize the new blocks they've seen in an attestation. The new blocks are organized as a chain segment, so that block hashes link from finalized attestation `n` to the new attestation `n + 1`. Eligible Attestors sign their respective attestation votes with BLS signatures and submit them to the P2P gossip network.

3. The off-chain P2P gossip network coordinates the attestation votes, validates them, and aggregates the BLS signatures.

4. Once a quorum of votes for an attestation is reached, any attestor in the active set is free to submit the consensus attestation along with attestor votes on-chain

5. The Creditcoin Validators then verify the aggregated votes (including Attestor eligibility and the aggregated BLS signature), verify the attestation's continuity chain of hashes, and store the attestation on-chain if valid.


This approach reduces on-chain traffic by consolidating multiple attestor votes into a single transaction with a single aggregated signature, enabling efficient scaling to larger Attestor networks.

The following diagram provides a visualization of this process:

![](https://docs.attestcoin.org/~gitbook/image?url=https%3A%2F%2Fcontent.gitbook.com%2Fcontent%2FwbWiMmiJwIjYCxeoW47K%2Fblobs%2F4eXI9JvT2AyEadbkrqxl%2FAttestation-Process-Overview.avif&width=768&dpr=3&quality=100&sign=2b37dd13aa129737d2b8c36e6f50a410&sv=3)

[PreviousAttestcoin Readability](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability) [NextContinuity Proving for Attestation](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation/continuity-proving-for-attestation)

Was this helpful?