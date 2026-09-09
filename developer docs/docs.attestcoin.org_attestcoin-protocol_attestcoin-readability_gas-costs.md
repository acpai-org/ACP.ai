---
url: "https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/gas-costs"
title: "Gas Costs | Attestcoin"
---

For the complete documentation index, see [llms.txt](https://docs.attestcoin.org/llms.txt). This page is also available as [Markdown](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/gas-costs.md).

Note: Unreasonably large transactions (> 500 KB) may not be provable using Attestcoin Readability. Verifying and decoding such transactions can exceed the Creditcoin EVM block-gas-limit, making them unprocessable.

## What Influences Verification Cost?[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/gas-costs\#what-influences-verification-cost)

1. **Continuity Proof Length (Large effect):** For each block in a continuity proof, the Block Prover Precompile must perform a hashing operation to calculate a digest. All these hashing ops cost gas. For historical transactions, continuity proofs can be quite long (Eg: 1000 blocks). If you aren't already familiar with what a continuity proof is, see [continuity proving for queries](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/continuity-proving-for-queries).

2. **Merkle Proof Size (Small effect):** Merkle proof size grows modestly as you increase the number of transactions in a block. For example:



   - 1024 tx block -> 11 hash merkle proof (1 to get leaf + 10 with siblings)

   - 1 tx block -> 1 hash merkle proof

     This will cause some modest fluctuation in gas costs, but isn't a large factor.


3. **Transaction Data Size:** While not strictly a part of the verification process, transaction decoding is still a necessary step for Attestcoin Readability. For almost all transactions the cost of decoding is negligable. But a few outliers make this cost potentially noteworthy.

Transaction types to avoid:



   - A single transaction in which contracts circularly call each-other 1000's of times

   - Transactions which bundle state updates for layer 2 rollup chains

     If you do happen request verification and decoding of very large transactions repeatedly, then the cost will add up. Estimated cost for 1 maximal decoding workload is **0.0375 CTC**.


## Verification Gas Equation[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/gas-costs\#verification-gas-equation)

Below we provide a line of best fit equation which roughly estimates the gas cost of a query given the length of its continuity proof.

### Cost formula[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/gas-costs\#cost-formula)

_Cost ≈ (base tx cost) + (hash op cost) · (continuity hash count)_

Based on it the approximate costs are:

**CTC Cost ≈ 2.3×10** **−5****\+ 2.9×10** **−7****\\* (continuity hash count)**

## Continuity Length Scenarios[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/gas-costs\#continuity-length-scenarios)

1. Transaction which was finalized 10 minutes ago at height 10,870,001
Because this transaction is recent, we have an attestation in storage at block 10,870,010. So continuity proof verification requires 10 hashing ops.

This gives us the expected price: **2.59x10** **−5** **CTC**

2. Same transaction as in the first case, but we've waited another 24 hours
Now that we've waited for 1 day, the attestations in storage got replaced by more sparse checkpoints (1 per 1000 blocks). So continuity proof verification requires 1000 hashing ops.

This gives us an expected price: **3.13×10** **−4** **CTC**

**That's more than 10x higher cost!**


## **Key Takeaways**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/gas-costs\#key-takeaways)

- The cost of Attestcoin Protocol Readability is currently quite low, facilitating as much traffic as desired

- To future proof against the potential of rising readability costs, try to make verification requests for transactions when they are recently finalized. This will reduce average continuity proof length by a factor of 10-100x.


[PreviousMerkle Proving and Transaction Inclusion](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/merkle-proving-and-transaction-inclusion) [NextAttestcoin Writability](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-writability)

Was this helpful?