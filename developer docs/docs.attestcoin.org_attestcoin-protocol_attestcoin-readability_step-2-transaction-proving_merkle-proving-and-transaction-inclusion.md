---
url: "https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/merkle-proving-and-transaction-inclusion"
title: "Merkle Proving and Transaction Inclusion | Attestcoin"
---

For the complete documentation index, see [llms.txt](https://docs.attestcoin.org/llms.txt). This page is also available as [Markdown](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/merkle-proving-and-transaction-inclusion.md).

> In case you aren't already familiar with Merkle proofs, 📰[this article](https://medium.com/@swastika0015/merkle-proofs-explained-208a72971a50) should give you a basic understanding of their use in the context of blockchain.

## **Motivation**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/merkle-proving-and-transaction-inclusion\#motivation)

When checking whether a transaction is part of a given block, we can either look through all the transactions in that block or use a _Merkle proof_.

Blocks can contain a very large number of transactions, so checking them one by one until we find the transaction we are looking for is _wildly_ inefficient! When verifying a Merkle proof we only need to access `log₂(n)` hashes in a block with `n` transactions.

This would be about 20 hashes for 1,000,000 transactions! A big difference.

## **Key Terms**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/merkle-proving-and-transaction-inclusion\#key-terms)

- **Merkle Tree**:A balanced tree data structure of hashes used to efficiently verify the integrity of large sets of data.

With the root of a Merkle tree and a small number of hashes from that tree, we can efficiently determine whether any given piece of data belongs to the set it describes. This property allows us to _efficiently_ determine whether any transaction `T` is contained in a block `B` , where `B` might contain many such transactions.

- **Root (Merkle Root)**: A Merkle root is the single cryptographic hash at the top of a Merkle tree, allowing us to rapidly verify the integrity of all the data stored in that tree.

- **Field**:In this context, a field is a part of a blockchain transaction. For example, a field could be the transaction `status` (success/failure) or the `value` field of a transfer event emitted by that transaction. A dApp's Attestcoin Smart Contract extracts transaction data directly from verified transaction bytes.

- **Standard Merkle Tree**: Attestcoin readability uses standard Merkle trees ( _Keccak-256_ hashing). Merkle proofs are verified natively by the precompile, providing fast and efficient verification without requiring specialized proof systems.


## **Merkle Proving Transaction Fields**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/merkle-proving-and-transaction-inclusion\#merkle-proving-transaction-fields)

In the example below, we show how fields containing the data we want are packed in transactions then hashed to form a Merkle tree. `Transaction 1`, as shown below, is an `ERC20` transfer. This implies it has fields such as `from`, `to`, and `value`.

> Other fields have been excluded from this diagram for simplicity's sake.

Note how the transaction fields we want to prove are all part of a single transaction, `T1`. Each transaction in the block is hashed to form a leaf node. These leaf nodes are then combined pairwise and hashed to form parent nodes, with this process continuing recursively until a single `root` hash is created.

Using the hashes of each sibling node along the path to `T1` in combination with the Merkle root itself, we can prove that `T1` was part of this specific block. This is known as a 📰 [Merkle proof](https://medium.com/@swastika0015/merkle-proofs-explained-208a72971a50#c6a9). The Proof Builder service generates this Merkle proof and submits it (along with continuity proof) for verification to the native precompile, which verifies it by reconstructing the path from transaction to root.

Once the precompile has verified the Merkle proof (confirming `T1` is included in the block), the transaction data is immediately available. ASC contracts can then decode the fields they need directly from `T1`.

![](https://docs.attestcoin.org/~gitbook/image?url=https%3A%2F%2Fcontent.gitbook.com%2Fcontent%2FwbWiMmiJwIjYCxeoW47K%2Fblobs%2F9bWpaRj9GTe7cYgBmqiX%2Fimage.png&width=768&dpr=3&quality=100&sign=1f95fb25f1d0d484997e2cf71041e0ef&sv=3)

[PreviousContinuity Proving for Queries](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/continuity-proving-for-queries) [NextGas Costs](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/gas-costs)

Was this helpful?