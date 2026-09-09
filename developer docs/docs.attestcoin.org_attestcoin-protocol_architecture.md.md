---
url: "https://docs.attestcoin.org/attestcoin-protocol/architecture.md"
title: undefined
---

> For the complete documentation index, see [llms.txt](https://docs.attestcoin.org/llms.txt). Markdown versions of documentation pages are available by appending `.md` to page URLs; this page is available as [Markdown](https://docs.attestcoin.org/attestcoin-protocol/architecture.md).

# Architecture

A *decentralized oracle* is a provider of information external to a blockchain that does not rely on a centralized trusted entity for its security. Instead, each step in the oracle’s data provisioning process is executed by a group of independent actors, none of which have the power to unilaterally interfere with data provisioning outcomes.&#x20;

The Attestcoin Protocol adds native decentralized oracle capacity to Creditcoin, which enables smart contracts that can access the state of *any* blockchain. These smart contracts, known as **Attestcoin Smart Contracts** (ASCs), enable novel cross-chain applications that can react to verified events from other chains.

## **Attestcoin Protocol Key Terms** <a href="#usc-key-terms" id="usc-key-terms"></a>

* **Readability:** The process by which the Attestcoin Protocol reads data from another blockchain and exposes it for use in smart contracts on Creditcoin. Events, prices, whatever a contract needs to see.
* **Writability:** The process by which the Attestcoin Protocol sends messages to other blockchains. With writability, a contract on Creditcoin can send messages containing critical data to a destination chain and trigger actions based on that data.
* **Attestcoin Smart Contract (ASC):** A smart contract on Creditcoin that uses Attestcoin Protocol's readability or writability process.
* **Source chain:** A chain from which data is read using Attestcoin readability. We begin by first supporting `EVM` chains such as  `Ethereum`, with the eventual goal to enable data provisioning from any chain.
* **Destination chain:** A chain to which messages are sent using Attestcoin Protocol's writability
* **Creditcoin chain:** Creditcoin mainnet, testnet, or devnet. All these chains have Attestcoin Protocol infrastructure and Attestcoin Smart Contract support.
* **Attestation:** A cryptographic commitment to data from source chain blocks, validated through consensus.
* **Query:** A request to verify a transaction from a source chain on Creditcoin using readability. Each query specifies which source *chain*, *block number*, and *transaction* it wants to be verified. Once a transaction is verified, the dApp's attestcoin smart contract can extract the data it needs from the verified transaction bytes.
* **Proof:** A cryptographic proof certifying that a given transaction occurred on a source chain.

> Proofs consist of Merkle proofs (for transaction inclusion) and continuity proofs (for block chain integrity). These are verified at native speeds on Creditcoin. After verification, dApp contracts can extract relevant transaction data directly from verified transaction bytes.

* **Block Prover Precompile:** A native precompile on Creditcoin (address `0x0FD2`) that verifies queries at native speed. It verifies transaction inclusion and block inclusion using Merkle proofs and continuity proofs. See below for details.

The block prover precompile ***does not*** validate if a transaction was successful or not. It only validates if a transaction is included in a block and that block is really a part of the confirmed source chain. Therefore, a dApp's attestcoin smart contract **MUST** check the "status" field of the transaction to ensure security `0x1` → ✅ **Success**

## Architecture <a href="#architecture" id="architecture"></a>

The Attestcoin Protocol relies primarily on the following actors:

### Attestors <a href="#attestors" id="attestors"></a>

**Role in Readability**

These make assertions about their view of the latest state of a source chain, such as Ethereum. Creditcoin doesn't trust any single attestor's report about changes to a source chain's state. Instead, a decentralized network of attestors must reach consensus on what state changes, if any, have occurred. This consensus is provided as an aggregated signature of individual attestor votes that can be verified by Creditcoin validators.

**Role in Writability**

In writability, attestors play the mirror-image role: instead of verifying facts coming *from* other chains, they validate messages going *to* them. When a contract on Creditcoin publishes a cross-chain message through an Outbox contract, attestors observe the message and then vote to validate it. Once a consensus threshold of signatures is met, the message is considered validated and can be carried to the destination chain.

> For more information on attestors, check out the [Step 1: Attestation](/attestcoin-protocol/attestcoin-readability/step-1-attestation.md) section of the docs.

### Validators <a href="#validators" id="validators"></a>

These form the authority set of the Creditcoin blockchain. Validators receive attestation transactions, perform basic structural checks, and include them in blocks through consensus. The runtime (executed by validators) verifies attestor BLS signatures and checks that sufficient quorum has been reached before committing attestations to on-chain storage.

### Block Prover Precompile <a href="#native-query-verifier-precompile" id="native-query-verifier-precompile"></a>

The block prover precompile is a runtime component at address `0x0FD2` that supports Attestcoin Protocol's readability by verifying cross-chain data within Creditcoin transactions. It validates two proofs: a Merkle proof for transaction inclusion in a block, and a continuity proof linking that block to an on-chain attestation or checkpoint via a chain of block digests.

The precompile runs as compiled Rust code, avoiding EVM interpretation overhead. Verification is synchronous: given transaction data, a Merkle proof, and a continuity proof, it checks that the Merkle root matches the block in the continuity chain, that the chain ends at a valid attestation/checkpoint, and that block digests are correctly linked via cryptographic hashing.

Two functions are available: `verify()` (only view, no events) and `verifyAndEmit()` (state-changing, emits `TransactionVerified` events). ASC contracts use this to verify cross-chain events and transactions in a single transaction, replacing external proof systems and off-chain services.

### Message Relayers

**Role in Writability**

These carry validated messages from Creditcoin to their destination chains. A relayer listens to the attestor P2P network for messages that have reached the consensus signature threshold. Then the relayer delivers each message, along with its collected attestor votes, to an Inbox contract on the destination chain. Relayers are not part of consensus and never vote. Because any tampering would break the attestor signatures checked at the Inbox, a relayer cannot forge, alter, or misroute a message, only deliver it. The role is permissionless: anyone can operate a relayer, no bond is required, and relayers earn a delivery fee for each message they carry.

**Role in Readability**

Relayers can also serve the readability path, generating and submitting transaction proofs on behalf of dApps that prefer not to run their own infrastructure.

## Outcome for Builders <a href="#interoperability" id="interoperability"></a>

**Readability**

The net effect of readability is that third-party builders can create contracts on Creditcoin which have secure, trustless access to verified data from other chains. Attestcoin smart contracts can verify that specific transactions occurred on external blockchains (like Ethereum) and then react to those verified events by executing business logic on Creditcoin.

For example, a bridge contract could:

* Verify that a user burned or locked up ETH on Ethereum (by verifying the burn transaction using the precompile)
* Based on that verified proof, mint equivalent wrapped tokens on Creditcoin

Builders can leverage these properties to create attestcoin smart contracts which support their own custom cross-chain DApp business logic, enabling trustless cross-chain applications without relying on centralized oracles or intermediaries.

**Writability**

The net effect of writability is that Attestcoin Smart Contracts can act beyond Creditcoin: a contract can publish a message that, once validated by attestors, is delivered to a contract on a destination chain and triggers execution there. Builders get verified outbound reach without deploying bridge infrastructure of their own.

Continuing our bridge contract example, with writability the bridge contract could:

* Send a writability message declaring that wrapped ETH tokens were burned by a user
* Receive the signed and verified message on Ethereum, releasing the original locked ETH to the user

Combined with readability, this closes the information loop: builders can prove inbound events, act on them, send verified instructions back out, and even receive delivery confirmation.

> For more information on how to set up your dApp's logic to leverage the Attestcoin protocol, check out the [dApp Builder Infrastructure](/attestcoin-protocol/dapp-builder-infrastructure.md) section of the docs.

#### Conclusion

With readability and writability, the Attestcoin Protocol connects Attestcoin Smart Contracts (ASC) to a growing network of blockchains. With full bi-directional data flows, these contracts seamlessly integrate functionality and liquidity from many chains in one place. This makes the Attestcoin Protocol a cross-chain communication hub with network effects that grow with each connected chain.
