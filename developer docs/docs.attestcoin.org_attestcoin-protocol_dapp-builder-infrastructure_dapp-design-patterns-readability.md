---
url: "https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/dapp-design-patterns-readability"
title: "dApp Design Patterns: Readability | Attestcoin"
---

For the complete documentation index, see [llms.txt](https://docs.attestcoin.org/llms.txt). This page is also available as [Markdown](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/dapp-design-patterns-readability.md).

Please note that all information and code snippets provided in this section are for educational purposes only and not to be directly deployed in production.

## Attestcoin Protocol Readability Design Patterns[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/dapp-design-patterns-readability\#attestcoin-protocol-readability-design-patterns)

> _How you_ **can** _use Attestcoin Readability vs how you_ **should**.

Cross-chain dApps use [Attestcoin Smart Contracts](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts) in a way that is intended to be _maximally flexible_. With Attestcoin Protocol Readability, data from a source chain such as Ethereum can be securely moved cross-chain by the Attestcoin Protocol. That data can then be verified and used by a dApp's Attestcoin Smart Contract which lives on Creditcoin.

This way, the design space is left open for dApp teams to build whatever source chain logic they want and use Readability to provision whatever data they want.

Most projects, however, are best served by following a specific pattern.

### Source Chain dApp Contract[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/dapp-design-patterns-readability\#source-chain-dapp-contract)

> _For more detail, read our page covering_ [_Source Chain Smart Contracts_](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/source-chain-smart-contracts) _._

The scope of the source chain dApp contract should be as minimal as possible. It should focus on emitting events with data to be used by the [Attestcoin Smart Contract](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts) on Creditcoin.

We want to keep logic on the source chain as _minimal_ as possible!

1. Users call a source chain smart contract.

2. (optional) Sometimes there's a piece of business logic which must take place on the source chain. For example, burning tokens. If so then we execute that here before emitting events.

3. The source chain contract emits one or more events.


That's all!

### **Attestcoin Smart Contract**[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/dapp-design-patterns-readability\#attestcoin-smart-contract)

> _For more detail, read our page covering the_ [_Attestcoin Smart Contract_](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts) _._

We want to make executing the Attestcoin smart contract as _seamless_ as possible!

1. An off-chain worker listens for events from the source chain smart contract

2. The worker waits for the block containing the event to be attested on Creditcoin

3. The worker generates Merkle and continuity proofs using the Proof Builder service

4. The worker calls the ASC contract with proofs and encoded transaction data

5. The ASC verifies proofs synchronously using the Block Prover Precompile

6. The ASC executes business logic immediately in the same transaction. Business logic execution either takes place in the ASC itself, or in a separate dApp contract which is called by the ASC.


## Best Practices[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/dapp-design-patterns-readability\#best-practices)

Beyond the flow of data described above, we outline some best practices to manage the source chain side of your cross-chain dApp:

1. **An ASC-enabled dApp should have a single source chain contract** which emits all the events relevant to the Attestcoin Protocol. That way, the [offchain worker](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/offchain-readability-workers) building readability queries for your dApp only needs to follow events emitted from a single contract address.

2. **Unambiguous events:** Events should be unambiguous. Try to use unique events for each kind of readability query you want to submit. For instance, a lending dApp tracking loans on Ethereum would want separate events for `LoanInitiated` and `LoanRepaid`.

3. **Clear event naming**: Events should be named so that it's clear they will initiate cross-chain functionality. For instance, the event name `TokensBurnedForBridging` (as used in the examples) clearly indicates a token burn action with the intent to bridge tokens cross-chain.

4. **Avoid common events**: Don't initiate cross-chain functionality using common events such as standard `Transfer` events. Instead, prefer to wrap actions in calls that emit more specific events such as `TokensBurned`. This makes it easier for workers to filter and process the correct events.

5. **Include all necessary data**: Add all the relevant information you want moved cross-chain to the events emitted by the source chain contract. For instance, the `TokensBurned` event should have fields `from` and `value` indicating which account burned the tokens and how many tokens were burned. Otherwise the ASC on Creditcoin won't know which account to mint tokens to or how many.


[PreviousAttestcoin Smart Contracts](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts) [NextOffchain Readability Workers](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/offchain-readability-workers)

Was this helpful?