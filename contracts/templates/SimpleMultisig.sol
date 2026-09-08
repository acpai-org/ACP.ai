// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

// ─────────────────────────────────────────────────────────────────────────────
// Template: compact multisig wallet (vetted classic confirm-then-execute
// shape). N owners, M-of-N confirmations execute a plain native transfer to
// one destination. Deliberately minimal: no call-data execution (governance
// of raw calls is out of scope for a template), native value only.
// ─────────────────────────────────────────────────────────────────────────────

contract SimpleMultisig {
    address[] public owners;
    mapping(address => bool) public isOwner;
    uint256 public immutable threshold;

    struct Transaction {
        address payable destination;
        uint256 value;
        bool executed;
        uint256 confirmations;
        mapping(address => bool) confirmed;
    }

    uint256 public transactionCount;
    mapping(uint256 => Transaction) private transactions;

    event TransactionSubmitted(uint256 indexed txId, address destination, uint256 value);
    event TransactionConfirmed(uint256 indexed txId, address indexed owner);
    event TransactionExecuted(uint256 indexed txId, address destination, uint256 value);

    error NotOwner();
    error DuplicateOwner();
    error BadThreshold();
    error NotPending();
    error NotConfirmedBySender();
    error AlreadyExecuted();
    error NotEnoughConfirmations();
    error TransferFailed();

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner();
        _;
    }

    constructor(address[] memory owners_, uint256 threshold_) payable {
        if (owners_.length == 0) revert BadThreshold();
        if (threshold_ == 0 || threshold_ > owners_.length) revert BadThreshold();
        for (uint256 i; i < owners_.length; i++) {
            address o = owners_[i];
            if (o == address(0) || isOwner[o]) revert DuplicateOwner();
            isOwner[o] = true;
            owners.push(o);
        }
        threshold = threshold_;
    }

    function submit(address payable destination, uint256 value) external onlyOwner returns (uint256 txId) {
        txId = ++transactionCount;
        Transaction storage t = transactions[txId];
        t.destination = destination;
        t.value = value;
        emit TransactionSubmitted(txId, destination, value);
    }

    function confirm(uint256 txId) external onlyOwner {
        Transaction storage t = transactions[txId];
        if (txId == 0 || txId > transactionCount) revert NotPending();
        if (t.executed) revert AlreadyExecuted();
        if (t.confirmed[msg.sender]) revert NotConfirmedBySender();
        t.confirmed[msg.sender] = true;
        t.confirmations++;
        emit TransactionConfirmed(txId, msg.sender);
        if (t.confirmations >= threshold) {
            _execute(txId);
        }
    }

    function _execute(uint256 txId) private {
        Transaction storage t = transactions[txId];
        if (t.executed) revert AlreadyExecuted();
        if (t.confirmations < threshold) revert NotEnoughConfirmations();
        t.executed = true;
        (bool sent, ) = t.destination.call{value: t.value}("");
        if (!sent) revert TransferFailed();
        emit TransactionExecuted(txId, t.destination, t.value);
    }

    receive() external payable {}
}
