---
url: "https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/continuity-proving-for-queries"
title: "Continuity Proving for Queries | Attestcoin"
---

For the complete documentation index, see [llms.txt](https://docs.attestcoin.org/llms.txt). This page is also available as [Markdown](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/continuity-proving-for-queries.md).

Continuity proofs for queries are cryptographic proofs that link the queried source chain block to an on-chain attestation or checkpoint, establishing that the block is part of the finalized source chain. This is one of the two essential proving steps used by the Attestcoin Protocol to achieve trustless cross-chain data readability.

**Note:** Continuity proof generation for queries differs from continuity proofs used in attestation generation (see [Continuity Proving for Attestation](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation/continuity-proving-for-attestation)). This section focuses specifically on query continuity proofs.

## **Continuity Proof**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/continuity-proving-for-queries\#continuity-proof)

A continuity proof for a query cryptographically links the queried block to an attestation or checkpoint stored on Creditcoin. The proof structure contains:

- `lowerEndpointDigest`: The digest of the block before the query (`queryHeight - 1`), retrieved from indexed attestation data on Creditcoin

- `roots[]`: An array of Merkle roots for blocks from `queryHeight` to the attestation/checkpoint block


Digests are computed on-chain from these roots using this formula, which creates an unbroken cryptographic chain: `digest[i] = hash(blockNumber[i], merkleRoot[i], digest[i-1])`

## **Why Query Continuity Proofs Are Needed**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/continuity-proving-for-queries\#why-query-continuity-proofs-are-needed)

If queries didn't contain continuity proofs, there would be no way to link them to on-chain attestations. We therefore couldn't verify which queries correspond to legitimate source chain data. Malicious queries could:

- Present fake Merkle roots for non-existent blocks

- Claim transactions exist in blocks that were never finalized

- Use outdated or reorganized blocks


## Attestations vs Checkpoints[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/continuity-proving-for-queries\#attestations-vs-checkpoints)

Two goals of Attestcoin Protocol Readability are as follows:

1. Allow contracts on Creditcoin to read data from new blocks on source chains as quickly as possible.

2. Minimize the long term storage footprint of the attestation protocol which enables readability


In order to accomplish these two goals, attestation record storage on Creditcoin is broken into two pieces.

1. **Attestations**: Records of recent confirmed source chain blocks. New attestations corresponding to the latest source chain blocks are produced frequently (every two minutes for Ethereum)

2. **Checkpoints**: More sparse records covering historical source chain blocks. Checkpoints are produced less frequently (every 20 minutes for Ethereum) and take up much less storage space than attestations. When a checkpoint is produced, it replaces a large number of attestations, removing them from storage.


The Proof Builder service can generate continuity proofs using either attestations or checkpoints. It queries indexed data stored on Creditcoin (attestations and checkpoints) and constructs the continuity proof using the computed roots and digests from this indexed data.

## **Continuity Proof Construction**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/continuity-proving-for-queries\#continuity-proof-construction)

When an off-chain worker needs to query a transaction at a specific block height, the service constructs a continuity proof through the following steps:

### **1\. Determine Interval Endpoints**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/continuity-proving-for-queries\#id-1.-determine-interval-endpoints)

The service first identifies the attestation/checkpoint boundaries around the query:

1. **Find the Highest Attestation/Checkpoint Before the Query**



   - Queries indexed attestation/checkpoint data stored on Creditcoin

   - Identifies the most recent attestation or checkpoint with a block number less than `queryHeight`

   - Retrieves the computed digest from the indexed data to use as `lowerEndpointDigest`


2. **Find the Lowest Attestation/Checkpoint After the Query**



   - Queries indexed attestation/checkpoint data on Creditcoin for the earliest attestation or checkpoint with a block number greater than or equal to `queryHeight`

   - The proof must link to this attestation/checkpoint's digest

   - This serves as the upper endpoint of the continuity proof

   - For queries between checkpoints, this will be a checkpoint (ending in a checkpoint)


**Example:**

- Query height: 145

- Last attestation before query: Block 140 (digest: `0xabc...`)

- Next attestation after query: Block 150 (digest: `0xdef...`)

- Continuity proof must link blocks 145-150 to attestation at block 150


### **2\.** Query Indexed Data and **Fetch Source Chain Blocks**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/continuity-proving-for-queries\#id-2.-query-indexed-data-and-fetch-source-chain-blocks)

The service queries indexed attestation data on Creditcoin and fetches source chain blocks:

1. **Query Indexed Attestation Data:**



   - For queries between attestations: Retrieves the specific attestations from indexed data

   - For queries between checkpoints: Queries all attestations in the checkpoint interval range from indexed data

   - Uses the computed roots and digests from the indexed attestation data


2. **Fetch Block Headers**



   - Requests block headers from the source chain RPC node

   - Needs blocks from `queryHeight` to the next attestation/checkpoint block

   - Each block header contains: block number, Merkle root, previous block hash


3. **Verify Block Integrity**



   - Validates that blocks form a continuous chain

   - Ensures each block's `previousBlockHash` matches the previous block's hash

   - This ensures blocks haven't been tampered with or reorganized


**Example (continuing from above):**

- Queries indexed attestation data on Creditcoin for blocks 140-150

- Fetches blocks: 144, 145, 146, 147, 148, 149, 150

- Blocks 145-150 form the chain to the attestation


### **3\. Construct Digest Chain**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/continuity-proving-for-queries\#id-3.-construct-digest-chain)

The service constructs the digest chain using the computed roots and digests from the indexed attestation data on Creditcoin:

**Digest Calculation Formula:**

Copy

```
digest[i] = hash(blockNumber[i], merkleRoot[i], digest[i-1])
```

Where:

- `blockNumber[i]` is the block number (e.g., 145)

- `merkleRoot[i]` is the Merkle root from the block header

- `digest[i-1]` is the digest of the previous block


**Process:**

1. Start with the digest of the block before the query (`queryHeight - 1`)



   - This digest should match the `prev_digest` from the attestation/checkpoint before the query

   - If no previous attestation exists, use genesis digest


2. For each block from `queryHeight` to the attestation/checkpoint block, compute using roots from indexed data:











Copy



```
digest[144] = hash(144, root[144], prev_digest_from_attestation)
digest[145] = hash(145, root[145], digest[144])
digest[146] = hash(146, root[146], digest[145])
...
digest[150] = hash(150, root[150], digest[149])
```

3. The final digest (`digest[150]`) must match the digest stored in the indexed attestation/checkpoint data on Creditcoin at block 150.


### **4\. Build Continuity Proof Structure**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/continuity-proving-for-queries\#id-4.-build-continuity-proof-structure)

The continuity proof structure is simplified and only stores Merkle roots (digests are computed on-chain):

**Continuity Proof Structure:**

Copy

```
struct ContinuityProof {
    lowerEndpointDigest: bytes32,  // Digest of block (queryHeight - 1)
    roots: bytes32[]            // Array of Merkle roots
}
```

- `lowerEndpointDigest`: The digest of the block before the query (`queryHeight - 1`)



  - This is the `prev_digest` that the first block in the continuity chain references

  - Must match the digest from the attestation/checkpoint before the query


- `roots[]`: Array of Merkle roots for blocks from `queryHeight` to the attestation/checkpoint block



  - Block numbers are derived: `blockNumber = queryHeight + index`

  - Digests are computed on-chain from these roots (not submitted in proof)


## **Security**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/continuity-proving-for-queries\#security)

The fundamental security property of continuity proofs is the cascading effect of digest changes:

If any block in the continuity proof is modified:

1. The digest of that block changes (because it includes the block's Merkle root)

2. All subsequent block digests change (because each digest includes the previous digest)

3. The final digest will not match the on-chain attestation/checkpoint digest

4. This mismatch can be detected during verification, causing the proof to be rejected


**Example Attack Scenario:**

Copy

```
Attacker tries to modify block 147 in the continuity proof:
- Original block 147: root = 0x111, digest = 0xAAA
- Modified block 147: root = 0x222, digest = 0xBBB (changed!)

This causes cascading changes:
- Block 148: digest changes (uses 0xBBB instead of 0xAAA)
- Block 149: digest changes (uses changed digest from 148)
- Block 150: digest changes (uses changed digest from 149)

Final digest ≠ On-chain attestation digest → Tampering detected
```

[PreviousSteps of Transaction Proving](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/steps-of-transaction-proving) [NextMerkle Proving and Transaction Inclusion](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/merkle-proving-and-transaction-inclusion)

Was this helpful?