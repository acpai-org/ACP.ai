---
url: "https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts"
title: "Attestcoin Smart Contracts | Attestcoin"
---

For the complete documentation index, see [llms.txt](https://docs.attestcoin.org/llms.txt). This page is also available as [Markdown](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts.md).

Please note that all information and code snippets provided in this section are for educational purposes only and not to be directly deployed in production.

## What is the Attestcoin Smart Contract?[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts\#what-is-the-attestcoin-smart-contract)

**Attestcoin Smart Contract (ASC):** A smart contract on Creditcoin that uses Attestcoin Protocol Readability or Writability.

Unlike traditional omnichain or cross-chain solutions that focus narrowly on token transfers or specific assets, the Attestcoin Protocol provides a **general-purpose execution layer**. This enables contracts to act on externally verified data _without needing to rewrite core logic_.

By adopting the Attestcoin Protocol into their tech stack, developers can transform their contracts into _universal_ components powered by seamless cross-chain data, allowing for novel patterns of interoperability across multiple blockchains.

## Attestcoin Smart Contract Architecture[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts\#attestcoin-smart-contract-architecture)

ASCs verify cross-chain proofs and execute business logic. **DApp Business Logic Contracts** are contracts deployed on Creditcoin that contain the dApp's state and business logic.

In the example implementation (`SimpleMinterASC`), the business logic (ERC20 token minting) is integrated directly into the ASC itself. While this combined pattern works well for simple use cases, for more complex dApps developers can separate concerns by deploying distinct contracts:

- An Attestcoin smart contract that handles the core cross-chain read/write responsibilities

- And separate business logic contracts that the ASC contract calls after verification succeeds.


Both patterns are valid; the choice depends on the complexity and requirements of the dApp.

## How it works[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts\#how-it-works)

ASCs verify cross-chain transaction data using the **Block Prover Precompile** (address `0x0FD2`), a built-in runtime component that provides synchronous verification of Merkle and continuity proofs.

ASCs integrate with it by calling its `verify()` (or alternatively `verifyAndEmit()` ) function directly to verify proofs before processing cross-chain data. Once a transaction is verified, the ASC extracts transaction and event data directly from the verified transaction bytes and executes dApp-specific business logic.

**Key characteristics:**

- **Synchronous verification**: Proofs are verified in the same transaction, no async processing

- **Direct data extraction**: Transaction and event data is extracted directly from verified transaction bytes

- **Replay protection**: ASCs implement mechanisms to prevent duplicate processing

- **Native-speed execution**: The precompile runs as native Rust code for optimal performance


The block prover precompile _**does not**_ validate if a transaction was successful or not. It only validates if a transaction is included in a block and that block is really a part of the confirmed source chain. Therefore, a dApp's ASC **MUST** check the "status" field of the transaction to ensure security `0x1` → ✅ **Success**

## Core Attestcoin Smart Contract Pattern[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts\#core-attestcoin-smart-contract-pattern)

A typical ASC follows this pattern:

1. **Receives proofs and transaction data** from an off-chain worker

2. **Implements replay protection** to prevent duplicate processing

3. **Calls the Block Prover Precompile** to verify proofs synchronously

4. **Extracts transaction/event data** from verified transaction bytes

5. **Executes business logic** based on the verified data


### Example ASC Contract[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts\#example-asc-contract)

See [`ASCMinter.sol`](https://github.com/gluwa/attestcoin-protocol-examples/blob/main/contracts/sol/ASCMinter.sol) for a complete ASC implementation. The contract:

- Receives proofs and transaction data from offchain worker

- Implements replay protection using a `processedQueries` mapping

- Uses the Block Prover Precompile to verify proofs

- Validates transaction type and receipt status (must be successful)

- Extracts event data from verified transaction bytes using `EvmV1Decoder`

- Executes business logic (ERC20 token minting) within the same contract that mints tokens once a burn event is verified from the source chain


**Key function signature:**

Copy

```
function mintFromQuery(
    uint64 chainKey,
    uint64 blockHeight,
    bytes calldata encodedTransaction,
    bytes32 merkleRoot,
    INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
    bytes32 lowerEndpointDigest,
    bytes32[] calldata continuityRoots
) external returns (bool success)
```

### dApp Business Logic Contracts[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts\#dapp-business-logic-contracts)

dApp Business Logic Contracts are smart contracts deployed on Creditcoin that contain the dApp's state and business logic.

In the example implementation (`SimpleMinterASC`), the business logic is integrated directly into the ASC. The contract:

- Stores dApp state (e.g., token balances via ERC20)

- Implements dApp-specific logic (e.g., minting tokens)

- Executes business logic immediately after verifying cross-chain proofs and validating transaction contents

- Validates inputs and updates state accordingly


### Transaction Data Extraction[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts\#transaction-data-extraction)

After verification succeeds, ASCs extract transaction and event data from the `encodedTransaction` bytes as part of the transaction content validation process. The transaction encoding follows a deterministic format that includes:

- **Transaction fields**: Type, chain ID, nonce, from address, to address, value, etc.

- **Receipt fields**: Status, gas used, logs (events)

- **Event data**: Topics and data from transaction receipt logs


ASCs can use libraries like `EvmV1Decoder` to selectively extract specific events or transaction fields only needed for their business logic. This selective extraction allows ASCs to efficiently validate specific events or transaction fields needed for their business logic without decoding the entire transaction structure.

### Query Processing Flow[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts\#query-processing-flow)

When an oracle query worker provides proof data for a source chain transaction:

1. **Worker generates proofs** using the Proof Builder service

2. **Worker calls ASC contract** with proofs and encoded transaction data

3. **ASC contract verifies proofs** synchronously using the Block Prover Precompile

4. **ASC contract extracts data** from verified transaction bytes

5. **ASC contract executes business logic** immediately in the same transaction


All of this happens synchronously in a single transaction—there is no async query processing or result storage.

### Attestcoin Smart Contract Implementation Example[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts\#attestcoin-smart-contract-implementation-example)

The following sections break down a complete ASC implementation based on [`ASCMinter.sol`](https://github.com/gluwa/attestcoin-protocol-examples/blob/main/contracts/sol/ASCMinter.sol)

Since the creation of this article, the ASCMinter was updated to better reflect a production ready design. The minter responsibilities were split off into several contracts handling portions of the bridge token minting process. The code here, though not fit for production, more simply and succinctly demonstrates ASC design. So it remains unchanged.

#### Contract Structure[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts\#contract-structure)

The Block Prover Precompile was previously called Native Query Verifier, so you'll see that term throughout these code examples

Copy

```
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EvmV1Decoder} from "./EvmV1Decoder.sol";

contract SimpleMinterASC is ERC20 {
    INativeQueryVerifier public immutable VERIFIER;
    mapping(bytes32 => bool) public processedQueries;

    // ... rest of contract
}
```

**Key components:**

- **Inherits from ERC20**: The contract uses the combined pattern—it's both an ASC (requests proof verification and decodes tx data) and a business logic contract (`ERC20` token with minting logic)

- **VERIFIER**: Immutable reference to the Block Prover Precompile at address `0x0FD2`

- **processedQueries**: Mapping for replay protection, preventing duplicate processing of the same transaction


#### Main Entry Point: mintFromQuery[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts\#main-entry-point-mintfromquery)

Copy

```
function mintFromQuery(
    uint64 chainKey,
    uint64 blockHeight,
    bytes calldata encodedTransaction,
    bytes32 merkleRoot,
    INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
    bytes32 lowerEndpointDigest,
    bytes32[] calldata continuityRoots
) external returns (bool success) {
    // Calculate transaction index from merkle proof path
    uint256 transactionIndex = _calculateTransactionIndex(siblings);

    // Check if the query has already been processed
    bytes32 txKey;
    {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, chainKey)
            mstore(add(ptr, 32), shl(192, blockHeight))
            mstore(add(ptr, 40), transactionIndex)
            txKey := keccak256(ptr, 72)
        }
        require(!processedQueries[txKey], "Query already processed");
    }

    // First we verify the proof
    bool verified = _verifyProof(
        chainKey, blockHeight, encodedTransaction, merkleRoot, siblings,
        lowerEndpointDigest, continuityRoots
    );
    require(verified, "Verification failed");

    // Mark the query as processed
    processedQueries[txKey] = true;

    // Next we validate the transaction contents
    (bool valid, address burntFrom, uint256 burntValue) = _validateTransactionContents(encodedTransaction);
    require(valid, "Transaction contents validation failed");

    // Execute business logic (mint tokens) corresponding to the burn on the source chain
    _mint(burntFrom, burntValue);

    emit TokensMinted(address(this), burntFrom, burntValue, txKey);

    return true;
}
```

**Description:**

- **Parameters**: Receives all proof components and transaction data from the off-chain worker

- **Transaction Index Calculation**: Calculates the transaction index from the Merkle proof path using `_calculateTransactionIndex()`

- **Transaction Key Generation**: Creates a unique key from `chainKey`, `blockHeight`, and `transactionIndex` using assembly for gas efficiency

- **Replay Protection**: Checks if this transaction has already been processed

- **Proof Verification**: Calls `_verifyProof()` to verify the Merkle and continuity proofs synchronously

- **State Update (replay protection)**: Marks the transaction as processed in `processedQueries` mapping

- **Transaction Content Validation**: Validates the transaction contents by checking transaction type and receipt status.

- **Business Logic Execution:** If validation passes, executes business logic (minting tokens)

- **Event Emission**: Emits `TokensMinted` event with the transaction details


#### Constructor and Initialization[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts\#constructor-and-initialization)

Copy

```
constructor() ERC20("Mintable (TEST)", "TEST") {
    // Get the precompile instance using the helper library
    VERIFIER = NativeQueryVerifierLib.getVerifier();
}
```

**Description:**

- Initializes the ERC20 token with name and symbol

- Sets the `VERIFIER` immutable variable to the precompile instance

- The precompile address is constant and always available


#### Replay Protection[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts\#replay-protection)

Copy

```
mapping(bytes32 => bool) public processedQueries;
```

**Description:**

- **processedQueries**: Maps transaction keys to boolean values to track processed transactions


#### Proof Verification[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts\#proof-verification)

Copy

```
function _verifyProof(
    uint64 chainKey,
    uint64 blockHeight,
    bytes calldata encodedTransaction,
    bytes32 merkleRoot,
    INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
    bytes32 lowerEndpointDigest,
    bytes32[] calldata continuityRoots
) internal returns (bool verified) {
    INativeQueryVerifier.MerkleProof memory merkleProof =
        INativeQueryVerifier.MerkleProof({root: merkleRoot, siblings: siblings});

    INativeQueryVerifier.ContinuityProof memory continuityProof =
        INativeQueryVerifier.ContinuityProof({
            lowerEndpointDigest: lowerEndpointDigest,
            roots: continuityRoots
        });

    // Verify inclusion proof
    verified = VERIFIER.verifyAndEmit(chainKey, blockHeight, encodedTransaction, merkleProof, continuityProof);

    return verified;
}
```

**Description:**

- Constructs the `MerkleProof` and `ContinuityProof` structs from the provided components

- Calls the precompile's `verifyAndEmit()` function synchronously at address `0x0FD2`

- Returns `true` if both Merkle proof (transaction inclusion) and continuity proof (block attestation chain) are valid; reverts on failure (transaction reverts if verification fails)

- Emits `TransactionVerified` event on successful verification

- Verification happens in the same transaction - no async processing


#### Transaction Data Extraction[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts\#transaction-data-extraction-1)

The contract includes helper functions for extracting and validating transaction data from `encodedTransaction` bytes:

Copy

```
function _validateTransactionContents(bytes memory encodedTransaction)
    internal pure returns (bool found, address burntFrom, uint256 burntValue)
{
    // Validate transaction type
    uint8 txType = EvmV1Decoder.getTransactionType(encodedTransaction);
    require(EvmV1Decoder.isValidTransactionType(txType), "Unsupported transaction type");

    // Decode and validate receipt status
    EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
    require(receipt.receiptStatus == 1, "Transaction did not succeed");

    // Find transfer events and validate
    EvmV1Decoder.LogEntry[] memory transferLogs =
        EvmV1Decoder.getLogsByEventSignature(receipt, TRANSFER_EVENT_SIGNATURE);
    require(transferLogs.length > 0, "No transfer events found");

    // Get the original sender
    EvmV1Decoder.CommonTxFields memory txFields = EvmV1Decoder.decodeCommonTxFields(encodedTransaction);

    // Check if there's an actual burn transfer from the sender
    (found, burntFrom, burntValue) = _processTransferLogs(transferLogs, txFields.from);
    require(found, "No valid burn transfer found");

    return (found, burntFrom, burntValue);
}
```

**Description:**

- Uses `EvmV1Decoder` library to decode the transaction bytes

- Validates transaction type and receipt status

- Extracts event logs matching the `Transfer` event signature

- Validates that a burn transfer occurred (transfer to address < 128)


#### Complete Example[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts\#complete-example)

See [`ASCMinter.sol`](https://github.com/gluwa/attestcoin-protocol-examples/blob/main/contracts/sol/ASCMinter.sol) for the complete implementation with all helper functions and event processing logic. A corresponding helper script and instructions to use this code are available in the [hello-bridge example](https://github.com/gluwa/usc-testnet-bridge-examples/tree/main/hello-bridge).

[PreviousSource Chain Smart Contracts](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/source-chain-smart-contracts) [NextdApp Design Patterns: Readability](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/dapp-design-patterns-readability)

Last updated 4 days ago

Was this helpful?