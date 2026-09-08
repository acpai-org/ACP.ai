// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {INativeQueryVerifier, NativeQueryVerifierLib} from "./vendor/INativeQueryVerifier.sol";
import {EvmV1Decoder} from "./vendor/EvmV1Decoder.sol";

// ─────────────────────────────────────────────────────────────────────────────
// CrossChainSwapDestination — the DESTINATION side of the Attestcoin-secured
// cross-chain swap: an ASC on Creditcoin (testnet this phase).
//
// The contract is PRE-FUNDED with tCTC (constructor + fund()) by the liquidity
// provider. releaseWithProof() takes a Merkle + continuity proof of the
// source-chain (Sepolia) tx that contains a Locked event from the TRUSTED
// CrossChainSwapSource contract; verification happens ON-CHAIN via the Block
// Prover precompile; then the destination asset releases at the rate that was
// FIXED AT LOCK TIME — amount = ethAmount × rate — to the beneficiary recorded
// in the lock.
//
// Replay protection: spentLocks[lockId] — one release per lock, ever.
// The precompile doesn't check tx success — this contract requires status==1.
// Trusted-source pinning: only Locked events emitted by the pinned source
// contract address count (otherwise anyone could emit a fake Locked event).
// ─────────────────────────────────────────────────────────────────────────────

contract CrossChainSwapDestination {
    using EvmV1Decoder for bytes;

    INativeQueryVerifier public immutable VERIFIER;

    uint64 public immutable sourceChainKey;
    address public immutable trustedSourceContract;

    mapping(uint256 => bool) public spentLocks;

    /// @notice The liquidity provider (deployer) — the only address that can withdraw unspent tCTC.
    address public immutable funder;
    /// @notice Deployment time — the withdrawal gate counts from here.
    uint64 public immutable deployedAt;
    /// @notice Safety delay before the funder can withdraw: every lock created
    ///         at/near deployment expires within LOCK_WINDOW (24h) of its
    ///         creation; waiting 2× the window guarantees no unexpired lock can
    ///         still release against liquidity the funder pulls out.
    uint64 public constant WITHDRAW_DELAY = 48 hours;

    event Funded(address indexed funder, uint256 amount);
    event LiquidityWithdrawn(address indexed funder, uint256 amount);
    event SwapReleased(
        uint256 indexed lockId,
        address indexed beneficiary,
        uint256 ethAmount,
        uint256 rateTctcPerEth,
        uint256 tctcReleased,
        uint64 blockHeight,
        uint256 transactionIndex,
        bytes32 merkleRoot
    );

    error VerificationFailed();
    error WrongSourceChain();
    error NoLockedEvent();
    error LockAlreadySpent();
    error InsufficientLiquidity();
    error TransferFailed();
    error NotTrustedSource();
    error TxFailed();
    error LockExpired();
    error NotFunder();
    error WithdrawTooEarly();

    constructor(uint64 sourceChainKey_, address trustedSourceContract_) payable {
        require(trustedSourceContract_ != address(0), "trusted source required");
        VERIFIER = NativeQueryVerifierLib.getVerifier();
        sourceChainKey = sourceChainKey_;
        trustedSourceContract = trustedSourceContract_;
        funder = msg.sender;
        deployedAt = uint64(block.timestamp);
        if (msg.value > 0) {
            emit Funded(msg.sender, msg.value);
        }
    }

    /// @notice Top up the release liquidity (tCTC).
    function fund() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /// @notice Recover unspent liquidity after the withdraw delay (48h). The
    ///         funder is the deployer — in this phase the same user who locked
    ///         ETH. Without this, a failed/never-proven swap would strand the
    ///         pre-funded tCTC permanently.
    function withdraw() external {
        if (msg.sender != funder) revert NotFunder();
        if (block.timestamp < uint256(deployedAt) + uint256(WITHDRAW_DELAY)) revert WithdrawTooEarly();
        uint256 amount = address(this).balance;
        (bool sent, ) = payable(funder).call{value: amount}("");
        if (!sent) revert TransferFailed();
        emit LiquidityWithdrawn(funder, amount);
    }

    /// @notice Release destination funds against a verified proof of the source lock.
    function releaseWithProof(
        uint64 chainKey,
        uint64 blockHeight,
        bytes calldata encodedTransaction,
        bytes32 merkleRoot,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 lowerEndpointDigest,
        bytes32[] calldata continuityRoots
    ) external {
        if (chainKey != sourceChainKey) revert WrongSourceChain();

        INativeQueryVerifier.MerkleProof memory merkleProof =
            INativeQueryVerifier.MerkleProof({root: merkleRoot, siblings: siblings});
        INativeQueryVerifier.ContinuityProof memory continuityProof =
            INativeQueryVerifier.ContinuityProof({lowerEndpointDigest: lowerEndpointDigest, roots: continuityRoots});

        bool verified = VERIFIER.verify(chainKey, blockHeight, encodedTransaction, merkleProof, continuityProof);
        if (!verified) revert VerificationFailed();

        // Precompile proves inclusion only — success check is ours.
        uint8 txType = EvmV1Decoder.getTransactionType(encodedTransaction);
        require(EvmV1Decoder.isValidTransactionType(txType), "unsupported tx type");
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != 1) revert TxFailed();

        // Find the Locked(uint256,address,address,uint256,uint256,uint64) event
        // emitted by the TRUSTED source contract.
        bytes32 lockedSig = keccak256("Locked(uint256,address,address,uint256,uint256,uint64)");
        EvmV1Decoder.LogEntry[] memory logs = EvmV1Decoder.getLogsByEventSignature(receipt, lockedSig);
        bool matched = false;
        uint256 lockId;
        address destBeneficiary;
        uint256 ethAmount;
        uint256 rate;

        for (uint256 i; i < logs.length; i++) {
            EvmV1Decoder.LogEntry memory log = logs[i];
            if (log.address_ != trustedSourceContract) continue;
            if (log.topics.length != 4) continue;
            // topic0 = sig, topic1 = lockId (indexed), topic2 = depositor (indexed),
            // topic3 = destBeneficiary (indexed); data = (ethAmount, rate, expiresAt)
            uint256 candidateLockId = uint256(log.topics[1]);
            if (spentLocks[candidateLockId]) continue;
            (uint256 ethAmt, uint256 ratePerEth, uint64 expiresAt) = abi.decode(log.data, (uint256, uint256, uint64));
            // Expiry gate: after the lock window the depositor can claimRefund
            // the ETH on the source chain — releasing tCTC here too would pay
            // BOTH sides of the same lock (double payout). A proof of an
            // expired lock is a proof of a refundable/refunded lock, not a
            // live swap.
            if (block.timestamp > expiresAt) revert LockExpired();
            lockId = candidateLockId;
            destBeneficiary = address(uint160(uint256(log.topics[3])));
            ethAmount = ethAmt;
            rate = ratePerEth;
            matched = true;
            break;
        }
        if (!matched) revert NoLockedEvent();

        spentLocks[lockId] = true;

        // rate was fixed at lock time; amount = ethAmount * rate (checked mul).
        uint256 tctcAmount = ethAmount * rate;
        if (address(this).balance < tctcAmount) revert InsufficientLiquidity();

        uint256 transactionIndex = _calculateTransactionIndex(siblings);

        (bool sent, ) = payable(destBeneficiary).call{value: tctcAmount}("");
        if (!sent) revert TransferFailed();

        emit SwapReleased(lockId, destBeneficiary, ethAmount, rate, tctcAmount, blockHeight, transactionIndex, merkleRoot);
    }

    receive() external payable {
        // Direct transfers count as funding.
        emit Funded(msg.sender, msg.value);
    }

    function _calculateTransactionIndex(INativeQueryVerifier.MerkleProofEntry[] calldata siblings) internal pure returns (uint256) {
        uint256 index = 0;
        uint256 n = siblings.length;
        for (uint256 i = 0; i < n; i++) {
            if (siblings[i].isLeft) {
                index |= (1 << (n - 1 - i));
            }
        }
        return index;
    }
}
