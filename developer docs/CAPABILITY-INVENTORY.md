# Attestcoin Protocol — Capability Inventory (N32)

**Sources (authority order):** the repo's `developer docs/` folder (primary), the installed `@gluwa/usc-sdk` package's real export surface (runtime-verified), and LIVE calls against Creditcoin Testnet from this environment (2026-09-07). Every capability below is cited. Facts marked ⚡ were verified live from this sandbox.

## 1. Protocol primitives

| Capability | Detail | Citation |
|---|---|---|
| Readability | Read verified source-chain facts on Creditcoin; Merkle + continuity proofs verified natively | architecture.md |
| Writability | Send messages from Creditcoin to destination chains via Outbox→attestors→relayers→Inbox | attestcoin-writability.md — **status: "undergoing 3rd party testing and audits", NOT released on testnet** → out of scope this phase; no mocks (hard boundary 10) |
| Block Prover Precompile | `verify()` (view) + `verifyAndEmit()` (state-changing, emits `TransactionVerified(chainKey, height, transactionIndex)`) | architecture.md, smart-contracts.md |
| ChainInfo Precompile | Supported chains, genesis heights, attested heights/hashes, continuity bounds, checkpoints | SDK runtime + ⚡ live |
| Verification latency | One Creditcoin block (~15 s) once the source block is attested; synchronous, atomic, no async state | attestcoin-protocol.md |
| Batch verification | Up to 10 queries sharing one continuity proof; span < 1000 blocks | attestcoin-protocol.md, SDK doc (MAX_BATCH_SIZE=10, MAX_BATCH_RANGE=1000) |
| Tx status caveat | The precompile does NOT check tx success — ASCs MUST check receipt status == 0x1 | architecture.md, smart-contracts.md |
| Gas model | CTC ≈ 2.3e-5 + 2.9e-7 × (continuity hash count); recent txs 10–100× cheaper than day-old ones; > 500 KB txs may be unprovable | gas-costs.md |
| Replay protection | ASC pattern: `processedQueries` mapping keyed by (chainKey, blockHeight, txIndex) | smart-contracts.md |

## 2. Environment facts (⚡ live-verified)

| | Testnet (CC3) | Mainnet (CC3) |
|---|---|---|
| RPC | `https://rpc.cc3-testnet.creditcoin.network` ⚡ | `https://rpc.cc3-mainnet.creditcoin.network` |
| Proof builder | `https://proof-gen-api.cc3-testnet.creditcoin.network` | `https://proofbuilder.cc3-mainnet-usc.creditcoin.network` |
| Dashboard | `https://dashboard.cc3-testnet.creditcoin.network/` | `https://dashboard.cc3-mainnet-usc.creditcoin.network/` |
| Blockscout | `https://creditcoin-testnet.blockscout.com` | — |
| BlockProver | `0x…0FD2` | `0x…0FD2` |
| ChainInfo | `0x…0fd3` | `0x…0fd3` |
| Decoder | `0x731c345d79Fb8BbDC541f9DF3b6317585F849F9f` | `0x9D094C9f22B10FCf842c2fC6A0981630A4F94B5C` |
| Source chains | Sepolia chainKey 1 ⚡, Ethereum chainKey 3 ⚡ | Ethereum chainKey 1 |

⚡ `getSupportedChains()` on testnet returned exactly: chainKey 3→chainId 1, chainKey 1→chainId 11155111. Latest attested Sepolia height readable live.

## 3. SDK surface (`@gluwa/usc-sdk`, runtime-verified exports)

| Export | Members | What it gives us |
|---|---|---|
| `chainInfo` | `PrecompileChainInfoProvider` (getSupportedChains, getSupportedChainByKey, getAttestationGenesisHeight, getLatestAttestedHeightAndHash, getContinuityBounds, waitUntilHeightAttested, getAttestationHeightForDigest, getCheckpointForHeight), `CHAIN_INFO_PRECOMPILE_ADDRESS` | Live chain registry + attestation state |
| `proofProvider` | `service.ProofBuilder` (getProof, getBatchProof, waitUntilHeightAttested), `raw.RawProofBuilder` + `raw.blockProvider.SimpleBlockProvider`, `merkle.*` (TransactionMerkleProof, MerkleProofEntry, KeccakMerkleTree, computeMerkleRootOfBlock, computeDigestOf), `mergeProofs` | Proof acquisition + local proof math |
| `blockProver` | `PrecompileBlockProver` (verifySingle, verifyAndEmitSingle, verifyBatch, verifyAndEmitBatch, computeTransactionIndex), `BLOCK_PROVER_PRECOMPILE_ADDRESS` | On-chain verification (read + emit) |
| `utils` | `decoder.decodeEvmV1Transaction` / `formatDecodedTransaction`, `gas.computeGasLimit` / `gasAsPercentageOfMax` / `MAX_GAS_CAP`, `env.getEnv`, `hex` | Decode verified tx bytes, gas math |
| `queryBuilder` | `QueryBuilder.createFromTransactionHash/createFromTransaction`, `QueryBuilderForEvent`, `QueryBuilderForFunction`, `QueryableFields` (Type, TxFrom, TxTo, TxValue, TxData, …receipt fields) | Field/event-level query construction |
| `encoding` | `getTransactionWithRaw`, `abiEncode`, `RawTransactionResponse`, `addressOrZero`, `EncodingVersion` | Tx encoding helpers |

Proof data shape (builder getProof → data): `chainKey, headerNumber, txHash, txBytes, merkleProof{root, siblings}, continuityProof{lowerEndpointDigest, roots}, cached` — matches `INativeQueryVerifier.MerkleProof/ContinuityProof` structs the precompile consumes.

## 4. App's current usage (gap map input)

| Capability | Status in app | File |
|---|---|---|
| Proof fetch (getProof) | ✅ used | lib/attestcoin/proof.ts |
| Attestation status / wait | ✅ used (tools check_attestation_status, wait_for_attestation) | lib/attestcoin/status.ts, verify.ts |
| Network status (attested heights, lag) | ✅ used (tool attestcoin_network_status) | lib/attestcoin/status.ts |
| Live chainKey resolution | ✅ used (ChainInfo-derived) | lib/attestcoin/chains.ts |
| verifyAndEmit single + batch (submission) | ✅ used, gated on CREDITCOIN_SIGNER_KEY | lib/attestcoin/submit.ts |
| Batch chunking (≤10, <1000 span) + merged continuity | ✅ used | lib/attestcoin/batch.ts + submit.ts |
| ASC contracts (ConditionalRelease, CrossChainSwap*) | ✅ deployed via templates | contracts/ + agent tools |
| Payment proof pipeline (poller, certificates, QR) | ✅ used | lib/attestcoin/poller.ts, payment-attestation-card |
| **getSupportedChains (live)** | ❌ unused — static SOURCE_CHAINS fallback only | config.ts |
| **decoder.decodeEvmV1Transaction** | ❌ unused — decoded fields not surfaced to users/agent | — |
| **queryBuilder** | ❌ unused | — |
| **getContinuityBounds / getCheckpointForHeight** | ❌ unused (bounds shown nowhere) | — |
| **verifySingle as a READ-ONLY verdict** | ❌ unused (only verifyAndEmit writes) — a read-only "is this proof valid on-chain" check is available | — |
| **gas cost estimate** | ⚠ submit path only, via computeGasLimit; no pre-verification cost estimate surfaced | submit.ts |
| **Dashboard/Blockscout deep links** | ⚠ settings card + status panel link the dashboard root only | attestcoin-panel |
| **Attestation lag guidance** | ⚠ status tool returns lag; agent doesn't advise "verify soon after finalization = 10-100x cheaper" | gas-costs.md |

## 5. Gap map → this phase's additions (all doc-grounded)

1. **`decode_source_transaction` tool** — decode a verified/encoded source tx into human fields (type, from, to, value, receipt status) via `utils.decoder` + QueryBuilder fields. Gives the agent (and users) honest inspection of what a proof covers.
2. **`list_attestcoin_chains` tool** — LIVE supported chains + attested heights + lag from `getSupportedChains`/`getLatestAttestedHeightAndHash` (replaces guesswork; the registry fallback stays for outages).
3. **`estimate_verification_cost` tool** — the docs' cost model (2.3e-5 + 2.9e-7 × continuity length) + live continuity bounds via `getContinuityBounds` → CTC estimate BEFORE the user submits; includes the "recent = 10-100× cheaper" guidance.
4. **`verify_proof_readonly` tool** — `verifySingle` against the precompile (view call, no signer, no gas): an honest "the chain itself confirms this proof" verdict users can run without CREDITCOIN_SIGNER_KEY.
5. **`get_attestation_bounds`** — continuity bounds + checkpoint digest for a height (transparency into WHY a wait is needed and how long the proof chain will be).
6. **Proof URL propagation (N27)** — every source-chain action's completion carries explorer + blockscout + dashboard URLs (existing explorer helper + dashboard URL from config).
7. **Human-intervention transparency (N27)** — signer-key status surfaced wherever submission is required (already partially: submissionAvailability; needs chat-side surfacing + docs-based explanation).

Deliberately NOT built: writability flows (docs: not released on testnet — hard boundary 10 forbids mocks); RawProofBuilder local proving (the hosted builder is the recommended path and already wired); NFT transfers (explicitly deferred in explorer.ts).
