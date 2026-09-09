---
url: "https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/offchain-readability-workers"
title: "Offchain Readability Workers | Attestcoin"
---

For the complete documentation index, see [llms.txt](https://docs.attestcoin.org/llms.txt). This page is also available as [Markdown](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/offchain-readability-workers.md).

Please note that all information and code snippets provided in this section are for educational purposes only and not to be directly deployed in production.

## **Motivation for Offchain Readability Workers**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/offchain-readability-workers\#motivation-for-offchain-readability-workers)

In the future, 3rd party relayers will offer the submission of readability queries as a service. A dApp team may choose to pay a small fee per readability query rather than maintaining their own worker.

When Attestcoin Protocol Readability provisions data from one chain to another, there are two transactions involved:

1. **The user submits a transaction on the source chain.** Usually this would be a source chain smart contract call emitting some event for which we want to transfer data to the execution chain.

2. **The ASC contract must be called on Creditcoin.** This requires generating proofs and submitting a call to the ASC with proofs and encoded transaction data. The ASC verifies the proofs synchronously and executes business logic immediately.


The following diagram highlights where these two transactions take place:

![](https://docs.attestcoin.org/~gitbook/image?url=https%3A%2F%2Fcontent.gitbook.com%2Fcontent%2FwbWiMmiJwIjYCxeoW47K%2Fblobs%2F8CmHpg2S5Il7rJ7pRpot%2Fimage.png&width=768&dpr=3&quality=100&sign=ca92d6cbeccbe4b0da7753c4181a8150&sv=3)

The first transaction must always be submitted by the end user. However, the second transaction can be initiated by an off-chain worker on behalf of the user. Using an off-chain worker provides significant UX and technical benefits:

- **Seamless user experience**: Without a worker, users would need to wait for attestation (several minutes), manually generate proofs, format the proof data correctly, and then submit a second transaction. With a worker, users only need to sign the initial source chain transaction. Everything else happens automatically in the background.

- **Eliminates technical complexity for end users**: Proof generation requires calling the Proof Builder service, waiting for attestation, handling retries, and properly formatting complex proof structures (Merkle proofs, continuity proofs, encoded transactions). Off-chain workers handle all of this complexity automatically, so users don't need to understand the underlying oracle mechanics.

- **Reduces transaction failures and improves reliability**: Workers can implement robust retry logic, handle API failures gracefully, and ensure proper error handling. Users attempting manual proof generation are more likely to encounter failures due to timing issues (submitting before attestation completes), formatting errors, or network problems.

- **Enables better monitoring and observation**: Workers can track processing status, log events, and provide visibility into the cross-chain data flow. This helps DApp teams debug issues and monitor their DApp's health.


## Designing an Offchain Oracle Worker[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/offchain-readability-workers\#designing-an-offchain-oracle-worker)

Using an off-chain worker can drastically improve the UX of your cross-chain DApp by reducing the number of user interactions needed to trigger core business logic on the Creditcoin chain.

### Worker Transaction Flow[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/offchain-readability-workers\#worker-transaction-flow)

The worker automates the following process:

1. **Monitor source chain:** The worker constantly monitors the source chain contract for events (e.g., `TokensBurnedForBridging` events).

2. **Wait for attestation:** When an event is detected, the worker waits for the block containing the event to be attested on Creditcoin.

3. **Generate proofs:** The worker can generate Merkle and continuity proofs via the Proof Builder service.

4. **Call ASC contract:** The worker calls the ASC contract with the proofs and encoded transaction data. The ASC contract verifies the proofs synchronously and executes business logic immediately.

5. **Handle results:** The worker can listen for events from the ASC contract to confirm successful execution.


All of this happens automatically - the user only needs to sign the initial source chain transaction.

### Worker Implementation Considerations[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/offchain-readability-workers\#worker-implementation-considerations)

This has just been a starting point designed to introduce you to the use of Offchain Workers. Each dApp builder team will likely want to implement their Worker differently to fit the rest of their technology stack.

Keeping this in mind, the main goal of an Offchain Worker should always be robustness. This includes:

- **Retaining stored records of events in progress** in the event of a Worker shutdown

- **Catching up with any event that might have been missed** as a result of an unexpected shutdown

- **Avoiding submitting multiple ASC calls for the same event** (replay protection is handled by the ASC contract, but workers should also track processed events)

- **Following multiple source chain nodes** to listen for events in case a node experiences issues

- **Retrying failed proof generation or ASC calls** in case they fail. A call can fail for many reasons: for example, the Proof Builder services might be experiencing downtime or connectivity issues, or the ASC contract call might fail due to network issues


Below is an example of the logical flow that a more advanced oracle worker might use

[PreviousdApp Design Patterns: Readability](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/dapp-design-patterns-readability) [NextAttestcoin SDK (USC SDK)](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-sdk-usc-sdk)

Was this helpful?