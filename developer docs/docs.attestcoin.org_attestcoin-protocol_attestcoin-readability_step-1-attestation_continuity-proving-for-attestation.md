---
url: "https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation/continuity-proving-for-attestation"
title: "Continuity Proving for Attestation | Attestcoin"
---

For the complete documentation index, see [llms.txt](https://docs.attestcoin.org/llms.txt). This page is also available as [Markdown](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation/continuity-proving-for-attestation.md).

A continuity proof is one of two key proofs needed by Attestcoin Protocol Readability to securely move data from one chain to another. It organizes source chain blocks into a segment so that each block hash links to the next. Together these hashes/digests ensure that attestation `n + 1` is always a valid descendant of attestation `n`

Why do we need continuity proofs? Why can't attestors simply record consensus about every block? The answer has two parts:

1. **On-chain Storage:** Storing attestations for every source chain block on our Creditcoin chain would be too expensive, especially for chains like `Solana` that produce blocks frequently.

2. **Attestor Network Load:** The Attestor network must perform expensive signing, hashing, p2p gossip, and tx submission for every attestation it produces. We make the Attestor networks more resilient and efficient by not attesting to every block.


To solve both problems, we produce attestations at larger intervals (e.g., every 10 or 100 source chain blocks). Each attestation links to the previous one via digests. When there's a gap between attestations, a continuity proof fills it. This proof is a chain of digests of intermediate source chain blocks that:

- Starts from the block immediately after the last finalized attestation

- Ends at the block immediately before the new attestation

- Proves each intermediate block links to the previous one via digests


This lets the oracle handle queries for any source chain block—even if it wasn't explicitly stored—by proving continuity through the intermediate blocks. The continuity proof ensures that even though we only store attestations at intervals, we can still verify the integrity of the entire source chain.

## **Key Terms**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation/continuity-proving-for-attestation\#key-terms)

- **Hash:** A cryptographic hash is a deterministic mathematical function that takes an input of arbitrary size and produces a fixed-size output, called a hash value.

- **Merkle Tree**:A Merkle tree is a balanced binary tree of cryptographic hashes that enables efficient and secure verification of integrity of large data sets.

With the tree’s Merkle root and a small subset of hashes (a Merkle proof), one can efficiently verify whether a given piece of data is included in the set without revealing or re-hashing all the data. This property allows us to efficiently determine whether a part of a transaction is contained in the Merkle tree for a given block.

- **Root (Merkle Root)**: A Merkle root is the single cryptographic hash at the top of a Merkle tree. It uniquely summarizes all the data beneath it, allowing us to rapidly verify the integrity of all the data stored in that tree. Root in code:


Copy

```
let root = eth::starknet_pedersen_mmr(&block_data);
```

- **Digest:** Another term for any output from a hash function. In the context of the Attestcoin Protocol, a digest usually describes the hash output uniquely identifying a block or attestation. The digest of a block is derived by hashing its block number, Merkle root, and previous digest. Digest in code:


Copy

```
let digest = Self::hash_payload(&block_number.into(), &root, &prev_digest);
```

- **Previous Digest:** The previous digest of a block is just the digest of the block before it. We generate each new block digest using the previous digest.


## **How Hashing "Chains" Blocks Together**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation/continuity-proving-for-attestation\#how-hashing-chains-blocks-together)

Continuity proving relies on one of the key properties of blockchains. Namely, that the digest of each block is generated using both the contents of that block and the digest of the previous block. Since each block uses part of the previous block, the blocks are said to form a _chain_. This gives us a very important property:

> If the contents of block `x` are changed, then the digests of blocks `x, x+1, ... x+n` are _all changed_ as a result. This allows us to cheaply verify whether any part of the chain was changed using only the most recent block.

## **Generating Attestations**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation/continuity-proving-for-attestation\#generating-attestations)

An attestation is generated using the following process:

### 1\. Determine which source chain blocks to attest to[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation/continuity-proving-for-attestation\#id-1.-determine-which-source-chain-blocks-to-attest-to)

This is calculated as:

Copy

```
let next_attestation_block = latest_attestation_block + attestation_interval;
```

The attestation interval determines how frequently attestations are created on Creditcoin relative to source chain blocks. For example, if the attestation interval for Ethereum is 10, a new attestation is produced on Creditcoin for every 10 blocks on Ethereum. More specifically, if the `attestation_interval` is `10` and the last attestation was at block `100`, attestors will fetch blocks `101-110` and generate new attestation at height `110`.

### 2\. Fetch source chain blocks from source chain RPC nodes.[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation/continuity-proving-for-attestation\#id-2.-fetch-source-chain-blocks-from-source-chain-rpc-nodes)

Attestors either monitor the source chain directly or query an external trusted endpoint of their choice. As long as the attestor population represents a sufficiently diverse and distributed set of endpoints, rather than relying on just a few sources, it doesn't matter if individual attestors use external RPC endpoints.

### 3\. Construct an attestation fragment[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation/continuity-proving-for-attestation\#id-3.-construct-an-attestation-fragment)

Attestors fetch source chain blocks to build a continuity proof, a sequence of digests that bridges from one attestation to the next. As digests are added, each new digest is calculated as:

Copy

```
let digest = Self::hash_payload(&block_number.into(), &root, &prev_digest);
```

Each block's digest integrates the previous block's digest, forming a verifiable chain. At the end, the new attestation's `prev_digest` is set to the digest of the continuity proof's head block. The attestation itself has its own digest, calculated from the attestation's `root` and `prev_digest`.

This allows the attestation to be verified against the entire chain of intermediate digests, proving continuity even when blocks weren't explicitly stored. The following visual shows how digests bridge one attestation to the next.

![](https://docs.attestcoin.org/~gitbook/image?url=https%3A%2F%2Fcontent.gitbook.com%2Fcontent%2FwbWiMmiJwIjYCxeoW47K%2Fblobs%2FYb8qiee5nJPqcX89MeS5%2Fimage.png&width=768&dpr=3&quality=100&sign=fff417f488f3f833302f71f4848bd9c5&sv=3)

### 4\. Sign and submit to gossip network[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation/continuity-proving-for-attestation\#id-4.-sign-and-submit-to-gossip-network)

Each eligible attestor signs their attestation with both a _SR25519_ signature (for attestor identity) and a _BLS_ signature (for aggregation). The signed attestation (including the continuity proof) is then submitted to the P2P gossip network, where it is validated, coordinated with other Attestors' votes, and aggregated by other Attestors on that same network before on-chain submission.

## **Proving Continuity for Attestations**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation/continuity-proving-for-attestation\#proving-continuity-for-attestations)

**Note:** Continuity proof generation for attestations differs from continuity proofs generated for queries (see [Continuity Proving for Queries](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/continuity-proving-for-queries)). This section focuses specifically on attestation continuity proofs.

When generating attestations, Attestors construct a continuity proof chain linking blocks from the last finalized attestation (or checkpoint) to the current attestation height. The process:

- Determines the interval endpoints by finding the last finalized attestation/checkpoint on-chain and identifying the current attestation height

- Fetches source chain blocks between these endpoints and constructs the continuity proof. For attestations, the continuity proof starts from the block after the last finalized attestation and extends to the current attestation height

- Computes block digests using the formula: `digest = hash(block_number, merkle_root, prev_digest)`, creating an unbroken cryptographic chain

- Returns the continuity proof verifying that hashing was done correctly on the input blocks


The attestation includes this continuity proof and a `prev_digest` field. For a continuity proof to be valid, the `prev_digest` of the prospective attestation must match the digest of the last continuity block.

When the attestation is submitted to Creditcoin, the runtime verifies the validity of the continuity proof by reconstructing the digest chain and checking if the final digest matches the attestation's `prev_digest`. If verification succeeds, the attestation is stored on-chain.

### **Security**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation/continuity-proving-for-attestation\#security)

If a malicious attestor creates an internally consistent attestation with bogus blocks; the primary defense is consensus - since honest Attestors will not be using the bogus block, their final digest will be different, thus preventing the malicious attestation from reaching quorum. The following visual shows how a faulty attestation is rejected:

![](https://docs.attestcoin.org/~gitbook/image?url=https%3A%2F%2Fcontent.gitbook.com%2Fcontent%2FwbWiMmiJwIjYCxeoW47K%2Fblobs%2Fh01BAyHkuskjVHbZFXUO%2Fimage.png&width=768&dpr=3&quality=100&sign=a5cedecce0e7b84301adb7465a2389ea&sv=3)

[PreviousStep 1: Attestation](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation) [NextStep 2: Transaction Proving](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving)

Was this helpful?