// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

// ─────────────────────────────────────────────────────────────────────────────
// Template: simple escrow / vault. The depositor escrows native value at
// deployment; an arbiter can release to the beneficiary or refund the
// depositor; after the deadline anyone can trigger the refund. Vetted shape:
// no tokens, no external calls beyond plain value transfers.
// ─────────────────────────────────────────────────────────────────────────────

contract SimpleEscrow {
    address public immutable depositor;
    address payable public immutable beneficiary;
    address public immutable arbiter;
    uint256 public immutable amount;
    uint256 public immutable deadline;
    bool public concluded;

    event Released(uint256 amount);
    event Refunded(uint256 amount);

    error Concluded();
    error OnlyArbiter();
    error DeadlineNotReached();
    error TransferFailed();

    constructor(address payable beneficiary_, address arbiter_, uint64 deadlineHours_) payable {
        require(msg.value > 0, "escrow amount required");
        require(beneficiary_ != address(0), "beneficiary required");
        require(deadlineHours_ > 0, "deadline required");
        depositor = msg.sender;
        beneficiary = beneficiary_;
        arbiter = arbiter_ == address(0) ? msg.sender : arbiter_;
        amount = msg.value;
        deadline = block.timestamp + uint256(deadlineHours_) * 1 hours;
    }

    function release() external {
        if (concluded) revert Concluded();
        if (msg.sender != arbiter) revert OnlyArbiter();
        concluded = true;
        (bool sent, ) = beneficiary.call{value: amount}("");
        if (!sent) revert TransferFailed();
        emit Released(amount);
    }

    function refund() external {
        if (concluded) revert Concluded();
        if (msg.sender != arbiter && block.timestamp <= deadline) revert DeadlineNotReached();
        concluded = true;
        (bool sent, ) = payable(depositor).call{value: amount}("");
        if (!sent) revert TransferFailed();
        emit Refunded(amount);
    }

    receive() external payable {
        revert("no top-up");
    }
}
