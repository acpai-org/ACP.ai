// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

// ─────────────────────────────────────────────────────────────────────────────
// CrossChainSwapSource — the SOURCE side of the Attestcoin-secured cross-chain
// swap, deployed on the source chain (Sepolia).
//
// lock() escrows native ETH and emits a Locked event carrying everything the
// destination release contract needs: depositor, destination beneficiary,
// ETH amount, and the tCTC/ETH rate FIXED AT LOCK TIME. The destination ASC
// (CrossChainSwapDestination on Creditcoin) verifies a proof of this tx and
// releases at exactly this rate — neither side can reprice.
//
// claimRefund() returns the ETH if the destination release never happens
// before the lock expires (stale-proof / failed-swap safety).
// ─────────────────────────────────────────────────────────────────────────────

contract CrossChainSwapSource {
    struct Lock {
        address depositor;
        address destBeneficiary;
        uint256 ethAmount;
        uint256 rateTctcPerEth; // fixed at lock time
        uint64 expiresAt;
        bool claimed;
    }

    uint256 public lockCount;
    mapping(uint256 => Lock) public locks;

    event Locked(
        uint256 indexed lockId,
        address indexed depositor,
        address indexed destBeneficiary,
        uint256 ethAmount,
        uint256 rateTctcPerEth,
        uint64 expiresAt
    );
    event RefundClaimed(uint256 indexed lockId, address indexed depositor, uint256 ethAmount);

    error LockExpired();
    error LockStillActive();
    error AlreadyClaimed();
    error ZeroAmount();
    error ZeroRate();
    error ZeroBeneficiary();
    error TransferFailed();

    uint64 public constant LOCK_WINDOW = 24 hours;

    function lock(address destBeneficiary, uint256 rateTctcPerEth) external payable returns (uint256 lockId) {
        if (msg.value == 0) revert ZeroAmount();
        if (rateTctcPerEth == 0) revert ZeroRate();
        // A zero beneficiary would burn the released tCTC (the destination pays
        // the recorded beneficiary — payable(0x0).call succeeds).
        if (destBeneficiary == address(0)) revert ZeroBeneficiary();
        lockId = ++lockCount;
        locks[lockId] = Lock({
            depositor: msg.sender,
            destBeneficiary: destBeneficiary,
            ethAmount: msg.value,
            rateTctcPerEth: rateTctcPerEth,
            expiresAt: uint64(block.timestamp + LOCK_WINDOW),
            claimed: false
        });
        emit Locked(lockId, msg.sender, destBeneficiary, msg.value, rateTctcPerEth, uint64(block.timestamp + LOCK_WINDOW));
    }

    function claimRefund(uint256 lockId) external {
        Lock storage l = locks[lockId];
        if (l.claimed) revert AlreadyClaimed();
        if (block.timestamp <= l.expiresAt) revert LockStillActive();
        l.claimed = true;
        (bool sent, ) = payable(l.depositor).call{value: l.ethAmount}("");
        if (!sent) revert TransferFailed();
        emit RefundClaimed(lockId, l.depositor, l.ethAmount);
    }

    receive() external payable {
        revert("use lock()");
    }
}
