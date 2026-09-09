---
url: "https://docs.attestcoin.org/llms.txt"
title: undefined
---

# Attestcoin

## Attestcoin Docs

- [Attestcoin Protocol](https://docs.attestcoin.org/attestcoin-protocol.md): Description of the Attestcoin Protocol, which acts a cross-chain interoperability hub hosted on Creditcoin
- [Architecture](https://docs.attestcoin.org/attestcoin-protocol/architecture.md): Highest level description of the inner workings of the Attestcoin Protocol
- [Attestcoin Readability](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability.md)
- [Step 1: Attestation](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation.md): Attestcoin Protocol Readability Step 1: The attestation subsystem of readability achieves consensus about the confirmed state of a foreign chain and records that consensus on Creditcoin.
- [Continuity Proving for Attestation](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-1-attestation/continuity-proving-for-attestation.md): Continuity proofs make it possible to efficiently verify data from any block on a source chain. Without continuity proofs we would need to run 10-100x more consensus votes and store 100x more data.
- [Step 2: Transaction Proving](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving.md): Attestcoin Protocol Readability Step 2: The proving subsystem of Readability uses attestations and source chain blocks to prove that a particular transaction took place on a source chain.
- [Steps of Transaction Proving](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/steps-of-transaction-proving.md)
- [Continuity Proving for Queries](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/continuity-proving-for-queries.md): Attestcoin Protocol Readability uses Continuity proving to efficiently determine whether a given block is part of a source chain. It is the first of two key proofs that certify readability data.
- [Merkle Proving and Transaction Inclusion](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/step-2-transaction-proving/merkle-proving-and-transaction-inclusion.md): Attestcoin Protocol Readability uses Merkle proving to determine whether a transaction is included in a given block. It is the second of two key proofs that certify oracle results.
- [Gas Costs](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/gas-costs.md): The on-chain verification of readability queries incurs normal gas costs for compute. We attempt to describe the scale and variance of those costs here.
- [Attestcoin Writability](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-writability.md)
- [dApp Builder Infrastructure](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure.md): Summarizes the infrastructure dApp builders must set up in order to effectively use the Attestcoin Protocol.
- [Source Chain Smart Contracts](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/source-chain-smart-contracts.md): An overview of source chain smart contracts and the best practice pattern to securely query their data on Creditcoin using Attestcoin Protocol Readability.
- [Attestcoin Smart Contracts](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts.md)
- [dApp Design Patterns: Readability](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/dapp-design-patterns-readability.md): An overview of common design patterns which allow a DApp to use the Attestcoin Protocol for cross chain readability.
- [Offchain Readability Workers](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/offchain-readability-workers.md): An overview of Offchain Workers and how to use them to streamline user interactions.
- [Attestcoin SDK (USC SDK)](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-sdk-usc-sdk.md): This page describes the SDK developed by Gluwa to seamlessly interact with the Attestcoin Protocol in a reliable and efficient manner
- [Attestcoin Protocol Chains - Environments](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-chains-environments.md): This page describes the various Creditcoin chains that are enabled for Attestcoin Protocol related flows
- [Guided Tutorials](https://docs.attestcoin.org/attestcoin-protocol/guided-tutorials.md)
- [Changelogs](https://docs.attestcoin.org/attestcoin-protocol/changelogs.md)
- [Attestcoin Protocol Operator Guides](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides.md): There are two decentralized operator roles for the Attestcoin Protocol on Creditcoin. Attestor and relayer. We detail the process of deploying these here.
- [Attestor Operator Guide](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/attestor-operator-guide.md): Describes in detail how to launch and monitor your own attestor on Creditcoin 3 Mainnet or Testnet
- [Per-chain Attestor Settings](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/per-chain-attestor-settings.md): Allows Attestor operator guide to be used with CC3 Mainnet or CC3 Testnet
- [Attestcoin Design Diagrams](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-design-diagrams.md): Diagrams intended as further reading for the Attestcoin Whitepaper.
- [Environments](https://docs.attestcoin.org/attestcoin-protocol/environments.md)
- [Mainnet](https://docs.attestcoin.org/attestcoin-protocol/environments/mainnet.md)
- [Testnet](https://docs.attestcoin.org/attestcoin-protocol/environments/testnet.md)
