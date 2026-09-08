// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title INativeQueryVerifier (vendored from @gluwa/usc-contracts write-ability)
/// @notice Block-prover precompile at 0x…0FD2: native verification of a
///         transaction's inclusion in a finalized block of an attested chain,
///         via a Merkle proof + continuity chain.
/// @dev Struct layouts + signature kept byte-identical with the canonical
///      interface. Vendored so every ASC compiles self-contained.
interface INativeQueryVerifier {
    struct MerkleProofEntry {
        bytes32 hash;
        bool isLeft;
    }

    struct MerkleProof {
        bytes32 root;
        MerkleProofEntry[] siblings;
    }

    struct ContinuityProof {
        bytes32 lowerEndpointDigest;
        bytes32[] roots;
    }

    /// @notice Verify a transaction's inclusion in a finalized block. Reverts on
    /// failure, returns true on success.
    function verify(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        MerkleProof calldata merkleProof,
        ContinuityProof calldata continuityProof
    ) external view returns (bool);

    /// @notice Verify + emit TransactionVerified. Identical verification semantics.
    function verifyAndEmit(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        MerkleProof calldata merkleProof,
        ContinuityProof calldata continuityProof
    ) external returns (bool);
}

/// @notice Helper for the Block Prover precompile.
library NativeQueryVerifierLib {
    address constant PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000FD2;

    function getVerifier() internal pure returns (INativeQueryVerifier) {
        return INativeQueryVerifier(PRECOMPILE_ADDRESS);
    }
}
