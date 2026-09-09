---
url: "https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving"
title: "Step 2: Transaction Proving | Attestcoin"
---

For the complete documentation index, see [llms.txt](https://docs.attestcoin.org/llms.txt). This page is also available as [Markdown](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving.md).

The query-prove-verify process enables Attestcoin Smart Contracts (ASC) to trustlessly verify and use data from source chains. The process consists of four main phases:

1. **Query Phase**: Identifying the target transaction for verification

2. **Proof Generation Phase**: Creating Merkle and continuity proofs

3. **Verification Phase**: Cryptographic verification of the proofs

4. **Data Extraction Phase**: Extracting transaction data from verified bytes


## **Proof Types**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving\#proof-types)

To prove that a transaction occurred on a source chain, the system uses two complementary cryptographic proofs:

- **Merkle Proofs**: Prove that a specific transaction `x` is part of block `y`

- **Continuity Proofs**: Prove that block `y` is part of the finalized source chain


Together, these proofs provide cryptographic certainty that a transaction actually occurred on the source chain, enabling trustless cross-chain applications.

Where are proofs generated, and where are they used?

- **Prover Server** (off-chain): Generates Merkle and continuity proofs on-demand

- [**Block Prover Precompile**](https://docs.attestcoin.org/attestcoin-protocol/architecture#native-query-verifier-precompile) (on-chain): Verifies proofs synchronously and extracts data


## Full Process Summary[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving\#full-process-summary)

1. A dApp team or end user identifies a target transaction they want to verify. This is usually done via a **Oracle Query Worker** that listens for source chain events and submits proving requests. Alternatively, for teams that don't want to stand up their own worker, paid 3rd party relayer submission of readability queries will be available in the near future.

2. The **Oracle Query Worker** requests proofs from the **Prover Server** via an endpoint like `proof-by-tx/{chain_key}/{tx_hash}` .

3. The **Prover Server** retrieves attestation data from Creditcoin and fetches source chain blocks.

4. The **Prover Server** then uses attestation and block data to construct a continuity proof and a merkle proof for the target tx. These proofs are returned to the **Oracle Query Worker.**

5. The **Oracle Query Worker** submits the target tx and its proofs to Creditcoin via a **Attestcoin Smart Contract** call. There, the tx and proofs are passed to the **Block Prover Precompile**

6. The **Block Prover Precompile** verifies both proofs synchronously, flagging whether the target tx is valid or invalid.

7. Once verified, the transaction data can be decoded and used for dApp business logic


[PreviousContinuity Proving for Attestation](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation/continuity-proving-for-attestation) [NextSteps of Transaction Proving](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/steps-of-transaction-proving)

Was this helpful?