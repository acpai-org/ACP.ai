// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Template: plain ERC-20 token (vetted — OpenZeppelin ERC20 core, no minting
// after deployment, no pausing, no governance). Deploys on any enabled chain.
// ─────────────────────────────────────────────────────────────────────────────

contract SimpleERC20 is ERC20 {
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply,
        address initialHolder
    ) ERC20(name_, symbol_) {
        require(initialHolder != address(0), "holder required");
        require(initialSupply > 0, "supply required");
        _mint(initialHolder, initialSupply * (10 ** uint256(decimals_)));
    }
}
