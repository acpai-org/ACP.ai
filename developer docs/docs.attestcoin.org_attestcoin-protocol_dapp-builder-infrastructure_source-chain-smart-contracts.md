---
url: "https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/source-chain-smart-contracts"
title: "Source Chain Smart Contracts | Attestcoin"
---

For the complete documentation index, see [llms.txt](https://docs.attestcoin.org/llms.txt). This page is also available as [Markdown](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/source-chain-smart-contracts.md).

Please note that all information and code snippets provided in this section are for educational purposes only and not to be directly deployed in production.

## What is a Source Chain Smart Contract?[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/source-chain-smart-contracts\#what-is-a-source-chain-smart-contract)

A source chain smart contract is a contract living on a source chain such as ![Ethereum Icon](https://docs.attestcoin.org/~gitbook/image?url=https%3A%2F%2Fcontent.gitbook.com%2Fcontent%2FwbWiMmiJwIjYCxeoW47K%2Fblobs%2F1HGXKkCWNis9C2mI9gAv%2Fimage.png&width=24&dpr=3&quality=100&sign=fb63de531693e36b6cecf1b70710ce78&sv=3)`Ethereum` that is supported by Attestcoin Protocol Readability. Source chain contracts have two main responsibilities:

1. Support any source chain logic required by their cross-chain dApp.

2. Emit events that contain the data their dApp needs to verify and process on Creditcoin


Let's focus on these one by one.

### Source chain logic[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/source-chain-smart-contracts\#source-chain-logic)

Most logic and data for cross-chain DApps should live in contracts on Creditcoin rather than the source chain. Keep source chain logic minimal—typically just enough to handle asset movements (e.g., burning tokens, locking assets) and emit events.

**Best practices:**

- Minimize source chain logic to reduce gas costs and complexity

- Keep business logic on Creditcoin



  - So that data and liquidity from many chains can be used in one place

  - And to benefit from lower transaction + storage costs


- Use source chain contracts primarily for emitting events that trigger cross-chain actions


### Emitting Events[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/source-chain-smart-contracts\#emitting-events)

This is the way by which the source _chain_ will communicate with Creditcoin. When a source chain contract emits an event, it becomes part of the transaction's receipt logs, which can be cryptographically verified on Creditcoin using Attestcoin Protocol Readability.

Imagine that you want a simple dApp which burns ERC20 tokens on Ethereum and mints corresponding ERC20 tokens on Creditcoin. Then you would want your source chain smart contract to emit an event such as `TokensBurnedForBridging`.

**Event design considerations:**

- Use `indexed` parameters for efficient filtering (up to 3 indexed parameters)

- Include all data the dApp needs in the event parameters

- Keep event signatures consistent to simplify parsing in ASC contracts


### Example Source chain contract[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/source-chain-smart-contracts\#example-source-chain-contract)

The following example shows a simple ERC20 contract that supports a token bridge dApp. When tokens are "burned" (transferred to a burn address), a custom `TokensBurnedForBridging` event is emitted, which can be verified on Creditcoin to trigger token minting.

**Key features:**

- Emits a custom `TokensBurnedForBridging` event for easy filtering by [offchain workers](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/offchain-readability-workers)

- Uses a burn address (`0x...01`) to represent token burning

- The `TokensBurnedForBridging` event includes all necessary data (`from`, `value`)

- Workers can easily filter for this specific event signature and then generate proofs to submit to the ASC contract


Copy

```
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TestERC20 is ERC20 {
    address public constant BURN_ADDRESS = address(1); // 0x...01

    /// @notice Emitted when tokens are burned (sent to the burn address).
    /// @param from The address burning their tokens
    /// @param value The amount of tokens burned
    event TokensBurnedForBridging(address indexed from, uint256 value);

    constructor() ERC20("Burn Test", "TEST") {
        // Mint sender initial supply
        _mint(msg.sender, 1_000_000 ether);
    }

    /// @notice "Burn" by transferring tokens to the 0x...01 sink address.
    /// @dev This does NOT reduce totalSupply; it only makes tokens inaccessible.
    /// @param amount The amount of tokens to burn
    /// @return success Whether the transfer succeeded
    function burn(uint256 amount) external returns (bool) {
        _transfer(msg.sender, BURN_ADDRESS, amount);
        emit TokensBurnedForBridging(msg.sender, amount);
        return true;
    }
}
```

[PreviousdApp Builder Infrastructure](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure) [NextAttestcoin Smart Contracts](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts)

Was this helpful?