---
url: "https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure"
title: "dApp Builder Infrastructure | Attestcoin"
---

For the complete documentation index, see [llms.txt](https://docs.attestcoin.org/llms.txt). This page is also available as [Markdown](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure.md).

Please note that all information and code snippets provided in this section are for educational purposes only and not to be directly deployed in production.

## Infrastructure Components[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure\#infrastructure-components)

The Attestcoin Protocol is intended for use by dApp builders. However, in order to use the oracle _effectively_ dApp teams will need to set up some infrastructure of their own.

### Source Chain Smart Contract[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure\#source-chain-smart-contract)

> Deployed on source chain like `Ethereum`, `Sepolia`

**What to implement:** A smart contract that supports the dApp's source chain logic and emits events that can be verified on Creditcoin.

**Key requirements:**

- Emit events with the data the dApp needs to verify

- Events should be structured to allow easy extraction of relevant fields

- Contract should handle any logic that must happen on the source chain (e.g., burning tokens)


**Example:** To support a token bridge dApp the source chain smart contract might be an ERC20 contract that emits `TokensBurnedForBridging` events.

### Attestcoin Smart Contract (ASC)[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure\#attestcoin-smart-contract-asc)

> Deployed on `Creditcoin`

**What to implement:** A smart contract that verifies cross-chain transaction data using the Native Query Verifier Precompile (address `0x0FD2`) and then executes the dApp's business logic.

**Key responsibilities:**

- Receives proofs (Merkle and continuity) and encoded transaction data from workers via a smart contract call

- Calls the Native Query Verifier Precompile on Creditcoin to verify proofs synchronously

- Extracts transaction/event data from verified transaction bytes

- Executes dApp Business Logic or calls separate business logic contract using the verified data


**Example:** In a token bridge dApp, the ASC interprets oracle-provided data corresponding to the burn event on the source chain.

### dApp Business Logic Smart Contracts[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure\#dapp-business-logic-smart-contracts)

> Deployed to `Creditcoin`

**What to implement:** One or more smart contracts that contain their dApp's state and business logic.

**Contract organization:** dApp developers have flexibility in how they organize their code:

- **Combined pattern**: ASC and business logic code can be kept in the same contract. This works well for simple use cases where the ASC contract directly implements the business logic (e.g., minting tokens).

- **Separated pattern**: ASC and business logic can be kept in separate contracts. The ASC contract handles verification and then calls separate business logic contracts after verification succeeds. This pattern provides better modularity and is recommended for complex dApps.


**Key responsibilities:**

- Store dApp state (e.g., token balances, user data)

- Implement dApp-specific logic (e.g., minting tokens, updating balances)

- Provide functions that can be called by their ASC contract

- Enforce access control (typically only allow calls from their ASC contract)


**Example:** For a token bridge, this might be an ERC20 contract on Creditcoin that mints tokens when the ASC contract verifies a burn event from the source chain.

**Integration pattern:**

- Grant the ASC contract special permissions (e.g., minter role, admin role)

- ASC contract calls business logic functions after verifying cross-chain data

- Business logic contracts validate inputs and update state accordingly


### Readability Worker[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure\#readability-worker)

> Deployed 💻`offchain`

**What to implement:** An off-chain service that monitors source chain events and automatically submits verified transactions to their ASC contract.

In the future Attestcoin relayers will offer a paid service to submit readability queries to dApp Attestcoin Smart Contracts. With this service, dApp teams can avoid standing up their own Oracle Workers, instead paying a small fee for query submission.

**Key responsibilities:**

1. Listen for events from the source Chain Smart Contract

2. Wait for the block containing the event to be attested on Creditcoin

3. Use the Proof Builder service to get Merkle and continuity proofs

4. Call the ASC contract with the proofs and encoded transaction data

5. Retry failed transactions, track processing status, prevent duplicates etc


**Basic worker flow:**

## Complete Flow[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure\#complete-flow)

With all four components in place:

1. **User** signs transaction on source chain → emits event

2. **Oracle Worker** detects event → waits for attestation → fetches proofs → calls ASC

3. **ASC Contract** verifies proofs → extracts data → calls Business Logic Contract

4. **Business Logic Contract** executes dApp logic → updates state


This enables seamless cross-chain interoperability where a transaction on one chain automatically triggers dApp logic execution on Creditcoin!

[PreviousAttestcoin Writability](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-writability) [NextSource Chain Smart Contracts](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/source-chain-smart-contracts)

Was this helpful?