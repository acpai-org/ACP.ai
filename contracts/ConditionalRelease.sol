// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {INativeQueryVerifier, NativeQueryVerifierLib} from "./vendor/INativeQueryVerifier.sol";
import {EvmV1Decoder} from "./vendor/EvmV1Decoder.sol";

// ─────────────────────────────────────────────────────────────────────────────
// ConditionalRelease — an Attestcoin Smart Contract (ASC) on Creditcoin.
//
// Financing / conditional release (the primary Phase-2 flow): the depositor
// escrows native tCTC at deployment; the beneficiary receives it ONLY when a
// submitted Merkle + continuity proof — verified ON-CHAIN by the Block Prover
// precompile (0x…0FD2) — establishes that a condition transaction actually
// happened on the source chain (Sepolia). Verification and release are ATOMIC.
//
// Condition model (set at deployment, immutable):
//   - payer      expected source-tx sender        (0 = any)
//   - payee      expected source-tx recipient     (0 = any; for ERC-20
//                conditions this is the TOKEN CONTRACT and erc20From/erc20To/
//                erc20MinAmount carry the transfer constraints)
//   - minValue   minimum native value of the tx   (0 = any)
//   - erc20*     optional ERC-20 Transfer-event constraints (token, from, to,
//                minAmount) matched against the tx's receipt logs
// At least one constraint must be non-zero — a conditionless release would let
// any attested Sepolia tx unlock the funds.
//
// The precompile does NOT check tx success (docs): this contract MUST and does
// require receipt status == 1.
//
// One-shot: the released flag is the replay protection for the escrow itself.
// After `releaseWindow` passes without a release, the depositor can claim a
// refund.
// ─────────────────────────────────────────────────────────────────────────────

contract ConditionalRelease {
    using EvmV1Decoder for bytes;

    INativeQueryVerifier public immutable VERIFIER;

    address public immutable depositor;
    address payable public immutable beneficiary;
    uint256 public immutable escrowAmount;
    uint256 public immutable releaseWindowEnd;

    // Source-chain condition (chainKey is fixed by the release() proof itself).
    uint64 public immutable sourceChainKey;
    address public immutable payer;
    address public immutable payee;
    uint256 public immutable minValue;
    address public immutable erc20Token;
    address public immutable erc20From;
    address public immutable erc20To;
    uint256 public immutable erc20MinAmount;

    enum State { Escrowed, Released, Refunded }
    State public state;

    event FundsEscrowed(address indexed depositor, address indexed beneficiary, uint256 amount, uint64 sourceChainKey, uint256 releaseWindowEnd);
    event Released(address indexed beneficiary, uint256 amount, uint64 chainKey, uint64 blockHeight, uint256 transactionIndex, bytes32 merkleRoot);
    event Refunded(address indexed depositor, uint256 amount);

    error NotEscrowed();
    error AlreadyReleased();
    error AlreadyRefunded();
    error ReleaseWindowStillOpen();
    error ReleaseWindowExpired();
    error VerificationFailed();
    error TransactionFailed();
    error ConditionNotMet(string reason);
    error EmptyCondition();

    uint256 private constant TRANSFER_EVENT_SIG =
        0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef; // keccak256(Transfer(address,address,uint256))

    constructor(
        address payable beneficiary_,
        uint64 sourceChainKey_,
        address payer_,
        address payee_,
        uint256 minValue_,
        address erc20Token_,
        address erc20From_,
        address erc20To_,
        uint256 erc20MinAmount_,
        uint64 releaseWindowHours_
    ) payable {
        require(msg.value > 0, "escrow amount required");
        require(beneficiary_ != address(0), "beneficiary required");
        require(releaseWindowHours_ > 0, "release window required");

        bool hasNative = (payer_ != address(0)) || (payee_ != address(0)) || (minValue_ > 0);
        bool hasErc20 = (erc20Token_ != address(0)) || (erc20From_ != address(0)) || (erc20To_ != address(0)) || (erc20MinAmount_ > 0);
        require(hasNative || hasErc20, "at least one condition constraint required");

        VERIFIER = NativeQueryVerifierLib.getVerifier();
        depositor = msg.sender;
        beneficiary = beneficiary_;
        escrowAmount = msg.value;
        sourceChainKey = sourceChainKey_;
        payer = payer_;
        payee = payee_;
        minValue = minValue_;
        erc20Token = erc20Token_;
        erc20From = erc20From_;
        erc20To = erc20To_;
        erc20MinAmount = erc20MinAmount_;
        releaseWindowEnd = block.timestamp + uint256(releaseWindowHours_) * 1 hours;
        state = State.Escrowed;

        emit FundsEscrowed(msg.sender, beneficiary_, msg.value, sourceChainKey_, releaseWindowEnd);
    }

    /// @notice Release the escrow by proving the condition transaction on-chain.
    /// @dev Callable by anyone (relayer pattern) — funds only ever go to the
    ///      immutable beneficiary. Verification + release are atomic.
    function release(
        uint64 chainKey,
        uint64 blockHeight,
        bytes calldata encodedTransaction,
        bytes32 merkleRoot,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 lowerEndpointDigest,
        bytes32[] calldata continuityRoots
    ) external {
        if (state != State.Escrowed) revert AlreadyReleased();
        if (block.timestamp > releaseWindowEnd) revert ReleaseWindowExpired();
        if (chainKey != sourceChainKey) revert ConditionNotMet("proof is for a different source chain");

        INativeQueryVerifier.MerkleProof memory merkleProof =
            INativeQueryVerifier.MerkleProof({root: merkleRoot, siblings: siblings});
        INativeQueryVerifier.ContinuityProof memory continuityProof =
            INativeQueryVerifier.ContinuityProof({lowerEndpointDigest: lowerEndpointDigest, roots: continuityRoots});

        bool verified = VERIFIER.verify(chainKey, blockHeight, encodedTransaction, merkleProof, continuityProof);
        if (!verified) revert VerificationFailed();

        _checkCondition(encodedTransaction);

        state = State.Released;

        // Compute the transaction index from the Merkle proof path (same
        // algorithm as the protocol examples).
        uint256 transactionIndex = _calculateTransactionIndex(siblings);

        (bool sent, ) = beneficiary.call{value: escrowAmount}("");
        if (!sent) revert TransactionFailed();

        emit Released(beneficiary, escrowAmount, chainKey, blockHeight, transactionIndex, merkleRoot);
    }

    /// @notice Refund the depositor once the release window has passed unreleased.
    function claimRefund() external {
        if (state != State.Escrowed) revert NotEscrowed();
        if (block.timestamp <= releaseWindowEnd) revert ReleaseWindowStillOpen();
        state = State.Refunded;
        (bool sent, ) = payable(depositor).call{value: escrowAmount}("");
        if (!sent) revert TransactionFailed();
        emit Refunded(depositor, escrowAmount);
    }

    function _checkCondition(bytes calldata encodedTransaction) internal view {
        // The precompile proves inclusion, NOT success — receipt status is on us.
        uint8 txType = EvmV1Decoder.getTransactionType(encodedTransaction);
        if (!EvmV1Decoder.isValidTransactionType(txType)) revert ConditionNotMet("unsupported tx type");

        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != 1) revert ConditionNotMet("source tx failed");

        bool hasNative = (payer != address(0)) || (payee != address(0)) || (minValue > 0);
        if (hasNative) {
            EvmV1Decoder.CommonTxFields memory txFields = EvmV1Decoder.decodeCommonTxFields(encodedTransaction);
            if (payer != address(0) && txFields.from != payer) revert ConditionNotMet("payer mismatch");
            if (payee != address(0) && (txFields.toIsNull || txFields.to != payee)) revert ConditionNotMet("payee mismatch");
            if (minValue > 0 && txFields.value < minValue) revert ConditionNotMet("value below minimum");
        }

        bool hasErc20 = (erc20Token != address(0)) || (erc20From != address(0)) || (erc20To != address(0)) || (erc20MinAmount > 0);
        if (hasErc20) {
            EvmV1Decoder.LogEntry[] memory transfers = EvmV1Decoder.getLogsByEventSignature(receipt, bytes32(TRANSFER_EVENT_SIG));
            bool matched = false;
            for (uint256 i; i < transfers.length; i++) {
                EvmV1Decoder.LogEntry memory log = transfers[i];
                if (erc20Token != address(0) && log.address_ != erc20Token) continue;
                if (log.topics.length != 3) continue;
                address from = address(uint160(uint256(log.topics[1])));
                address to = address(uint160(uint256(log.topics[2])));
                if (erc20From != address(0) && from != erc20From) continue;
                if (erc20To != address(0) && to != erc20To) continue;
                if (erc20MinAmount > 0 && abi.decode(log.data, (uint256)) < erc20MinAmount) continue;
                matched = true;
                break;
            }
            if (!matched) revert ConditionNotMet("no matching ERC-20 transfer in the proven tx");
        }
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

    receive() external payable {
        revert("no top-up");
    }
}
