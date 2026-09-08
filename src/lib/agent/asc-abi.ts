// ─────────────────────────────────────────────────────────────────────────────
// Shared ASC (Attestcoin Smart Contract) ABIs — imported by BOTH the client
// executors (wallet submissions) and the server preparation layer (live gas
// estimation via estimateGas on the exact calldata). No "use client"/"use
// server" directive: a plain module both runtimes can share.
// Shapes verified against contracts/*.sol (see src/tests/fund-safety + the
// compile-suite ABI parity checks).
// ─────────────────────────────────────────────────────────────────────────────

/** ConditionalRelease.release — the 7-param proof-carrying release (financing flow). */
export const CONDITIONAL_RELEASE_ABI = [
  {
    type: "function",
    name: "release",
    stateMutability: "nonpayable",
    inputs: [
      { name: "chainKey", type: "uint64" },
      { name: "blockHeight", type: "uint64" },
      { name: "encodedTransaction", type: "bytes" },
      { name: "merkleRoot", type: "bytes32" },
      {
        name: "siblings",
        type: "tuple[]",
        components: [
          { name: "hash", type: "bytes32" },
          { name: "isLeft", type: "bool" },
        ],
      },
      { name: "lowerEndpointDigest", type: "bytes32" },
      { name: "continuityRoots", type: "bytes32[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimRefund",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
] as const;

/** CrossChainSwapDestination — releaseWithProof + fund + withdraw. */
export const SWAP_DESTINATION_ABI = [
  {
    type: "function",
    name: "releaseWithProof",
    stateMutability: "nonpayable",
    inputs: [
      { name: "chainKey", type: "uint64" },
      { name: "blockHeight", type: "uint64" },
      { name: "encodedTransaction", type: "bytes" },
      { name: "merkleRoot", type: "bytes32" },
      {
        name: "siblings",
        type: "tuple[]",
        components: [
          { name: "hash", type: "bytes32" },
          { name: "isLeft", type: "bool" },
        ],
      },
      { name: "lowerEndpointDigest", type: "bytes32" },
      { name: "continuityRoots", type: "bytes32[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "fund",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
] as const;

/** CrossChainSwapSource.lock — the payable ETH lock. */
export const SWAP_SOURCE_ABI = [
  {
    type: "function",
    name: "lock",
    stateMutability: "payable",
    inputs: [
      { name: "destBeneficiary", type: "address" },
      { name: "rateTctcPerEth", type: "uint256" },
    ],
    outputs: [{ name: "lockId", type: "uint256" }],
  },
  {
    type: "function",
    name: "claimRefund",
    stateMutability: "nonpayable",
    inputs: [{ name: "lockId", type: "uint256" }],
    outputs: [],
  },
] as const;
