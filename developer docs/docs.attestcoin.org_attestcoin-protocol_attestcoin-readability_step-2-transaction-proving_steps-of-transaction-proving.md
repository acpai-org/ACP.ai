---
url: "https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/steps-of-transaction-proving"
title: "Steps of Transaction Proving | Attestcoin"
---

For the complete documentation index, see [llms.txt](https://docs.attestcoin.org/llms.txt). This page is also available as [Markdown](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/steps-of-transaction-proving.md).

The transaction proving process enables Attestcoin Smart Contracts to trustlessly verify and use data from source chains. The process consists of four main phases:

1. **Query Phase**: Identifying the target transaction for verification

2. **Proof Generation Phase**: Creating Merkle and continuity proofs

3. **Verification Phase**: Cryptographic verification of the proofs

4. **Data Extraction Phase**: Extracting transaction data from verified bytes


## Transaction Proving Visualized[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/steps-of-transaction-proving\#transaction-proving-visualized)

"Creditcoin (Runtime)"ProofGenBlock Prover PrecompileASC ContractAttestation Pallet (Storage)Proof Builder ServiceSource ChainBuilder/UserProofGenBlock Prover PrecompileASC ContractAttestation Pallet (Storage)Proof Builder ServiceSource ChainBuilder/UserQuery Preparation PhaseProof GenerationVerification PhaseData Extraction Phase1\. Fetch Block DataBlock + Transaction Data2\. Request Proofs3\. Fetch Attestations/CheckpointsAttestation Data4\. Fetch Source Chain BlocksBlock Headers5\. Generate Merkle Proof6\. Build Continuity ProofMerkle + Continuity Proofs7\. Submit cross-chain USC call8\. Call Precompile9\. Read Attestations/CheckpointsAttestation Data10\. Verify Continuity Chain, Merkle Proof, Query Block DigestReturn Result (bool + data)11\. Parse data and trigger business logicReturn result and emit events

### **Phase 1: Query Phase**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/steps-of-transaction-proving\#phase-1-query-phase)

A query specifies what needs to be proven:

- Source Chain: Which blockchain the transaction occurred on (identified by `chainKey`)

- Block Height: Which block contains the transaction

- Transaction: The specific transaction to verify (identified by transaction index or hash)


Example: "Prove that transaction at index 5 in block 18,000,000 on Ethereum mainnet actually occurred."

This query information is used to:

- Retrieve transaction data from the source chain

- Determine which source chain blocks need to be fetched

- Identify which attestations are needed for continuity proof


### **Phase 2: Proof Building Phase**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/steps-of-transaction-proving\#phase-2-proof-building-phase)

The Proof Builder service creates two complementary proofs that together prove the transaction is legitimate.

#### **2.1 Generating Merkle Proofs**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/steps-of-transaction-proving\#id-2.1-generating-merkle-proofs)

The service then requests the block at the specified height from a source chain RPC node. All transactions in the block are hashed to form a Merkle tree, with the Merkle root stored in the block header. The Merkle proof consists of:

- The Merkle root (from block header)

- Array of sibling hashes with position information

- The transaction bytes themselves


By providing the sibling hashes and the transaction bytes, anyone can reconstruct the path to the Merkle root. If the computed root matches the block header's root, the transaction is proven to be in that block.

#### **2.2 Generating Continuity Proofs**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/steps-of-transaction-proving\#id-2.2-generating-continuity-proofs)

Finally the service then takes our query block height and determines that query's attestation bounds. Attestation bounds consist of the closest attestations above and below the query block height.

Next, the server fetches all the source chain blocks between our lower and upper attestation bounds. These blocks are used to form a continuity proof as detailed in our next section, [Continuity Proving for Queries](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/continuity-proving-for-queries)

Now that both proofs have been generated, our Proof Builder returns the following:

- Merkle Proof: Proves transaction inclusion in a block

- Continuity Proof: Proves the block is part of the finalized source chain

- Encoded Transaction: The full transaction bytes (transaction + receipt data)


These three components together provide complete cryptographic proof that the transaction occurred on the source chain.

### **Phase 3: Verification Phase**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/steps-of-transaction-proving\#phase-3-verification-phase)

The off-chain worker (or user) calls the ASC contract function with the proofs and encoded transaction bytes. The ASC contract then calls the native query verifier precompile to verify the proofs.

#### **3.1 Merkle Proof Verification process:**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/steps-of-transaction-proving\#id-3.1-merkle-proof-verification-process)

- Start with: `leafHash = hash(transaction_bytes)`

- For each sibling: combine with sibling hash (left or right based on position)

- Final step: Check `computedRoot == merkleRoot` (from continuity proof roots array)


#### **3.2 Continuity Proof Verification process:**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/steps-of-transaction-proving\#id-3.2-continuity-proof-verification-process)

- Starting from the back of the continuity chain, compute the following for each block: `computedDigest = hash(block_number, merkleRoot, previousDigest)`

- Final step: Verify that `finalDigest == onChainAttestationDigest`


The verification happens synchronously in the same transaction execution.

- No Waiting: Results are available within seconds

- Atomic: Either all verification steps succeed (transaction continues) or all fail (transaction reverts)

- No Intermediate State: No query storage, no async processing, no waiting for finalization


ASC contracts can use verified data immediately in the same transaction, enabling complex cross-chain logic without multi-step async flows.

### **Phase 4: Data Extraction Phase**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/steps-of-transaction-proving\#phase-4-data-extraction-phase)

After verification succeeds, the ASC contract extracts the data it needs from the verified transaction bytes. The `encodedTransaction` bytes contain the full transaction data. It can be used to decode the transaction type, common fields, type-specific fields and the receipt fields.

Once data is extracted, the ASC contract:

- Validates the extracted data (e.g., receipt status = success, expected event found)

- Executes business logic based on the verified cross-chain data

- Updates contract state or triggers additional actions


**Example**: A bridge contract might:

1. Verify a `Transfer` event showing tokens were burned on Ethereum

2. Extract the `from`, `to`, and `value` from the event

3. Mint equivalent tokens on Creditcoin to the `to` address


[PreviousStep 2: Transaction Proving](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving) [NextContinuity Proving for Queries](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/continuity-proving-for-queries)

Was this helpful?