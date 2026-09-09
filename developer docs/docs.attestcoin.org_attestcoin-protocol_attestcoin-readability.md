---
url: "https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability"
title: "Attestcoin Readability | Attestcoin"
---

For the complete documentation index, see [llms.txt](https://docs.attestcoin.org/llms.txt). This page is also available as [Markdown](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability.md).

Attestcoin Protocol's readability allows Creditcoin users and contracts to read the state of any source chain. Readability relies on two key steps:

1. **Attestation** \- Proactively tracking and reaching consensus on the state changes of source blockchains.

2. **Transaction Proving** \- Once a user/builder has decided they want to read a piece of source chain data, the transaction containing that data must be proven. To save on-chain compute, we generate proofs off-chain then verify them on-chain. Then data from the proven transaction can be used to by smart contracts on Creditcoin.


With these two steps, Creditcoin contracts can connect to many previously isolated pools of data and liquidity.

## **Attestcoin Protocol's Readability Breakdown**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability\#data-provisioning-flow)

The diagram below depicts how the Attestcoin Protocol provides data from source _chains_ to Attestcoin Smart Contracts on Creditcoin.

This diagram uses some old terminology and is pending replacement. The term Creditcoin Decentralized Oracle below would now be called "Attestation chain & Block Prover Precompile"

![](https://docs.attestcoin.org/~gitbook/image?url=https%3A%2F%2Fcontent.gitbook.com%2Fcontent%2FwbWiMmiJwIjYCxeoW47K%2Fblobs%2F6bs9oGtmKtM2gUm6tmfJ%2FCreditcoin-Oracle-USC.png&width=768&dpr=3&quality=100&sign=c415360a01c63a61281495f9a4fb36e1&sv=3)

The diagram above illustrates the cross-chain movement of data using Attestcoin Protocol's readability.

### **Provisioning Steps**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability\#provisioning-steps)

- 1-2. Attestors listen for new source chain blocks, vote on attestations, and store those attestations on-chain. These are used later by the Block Prover Precompile to prove source chain transactions.

- 3a. Meanwhile, dApp builders listen for the emission of events on the source chain which are relevant to their dApp.

- 3b. When an event is detected, dApp builders send a request to the proof generation server asking for proofs of the transaction containing the target event.

- 3c. The transaction and proofs are submitted to a dApp's Attestcoin Smart Contract, which forwards them to the Block Prover Precompile.

- 4\. The Block Prover Precompile verifies merkle and continuity proofs, signaling whether or not the source chain transaction is valid

- 5\. The dApp's Attestcoin Smart Contract decodes the verified transaction, extracting the relevant event. It then uses the event to trigger dApp logic and emit events.


## **Attestcoin Protocol's Readability Example Use Case**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability\#creditcoin-oracle-example-use-case)

The following diagram demonstrates use of the Attestcoin Protocol (formerly called USC) to power cross-chain loans:

![](https://docs.attestcoin.org/~gitbook/image?url=https%3A%2F%2Fcontent.gitbook.com%2Fcontent%2FwbWiMmiJwIjYCxeoW47K%2Fblobs%2FIcFsU27TRr1VydY0ep8Z%2FUSC-Use-Case.png&width=768&dpr=3&quality=100&sign=5f226ed43f5d5122e847ad431b0ccc11&sv=3)

Red arrows represent the attestation process. Blue arrows represent the proving process which generates proofs for queries that are then verified synchronously by the Block Prover Precompile.

[PreviousArchitecture](https://docs.attestcoin.org/attestcoin-protocol/architecture) [NextStep 1: Attestation](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation)

Was this helpful?