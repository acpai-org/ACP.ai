---
url: "https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-sdk-usc-sdk"
title: "Attestcoin SDK (USC SDK) | Attestcoin"
---

For the complete documentation index, see [llms.txt](https://docs.attestcoin.org/llms.txt). This page is also available as [Markdown](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-sdk-usc-sdk.md).

The term USC (Universal Smart Contract) was replaced with the term Attestcoin Protocol. But repository names and other resources have yet to be updated. The usc-sdk is one such resource.

## Getting Started[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-sdk-usc-sdk\#getting-started-with-the-usc-sdk)

The `@gluwa/usc-sdk` is a **TypeScript/JavaScript SDK** for verifying cross-chain transactions on the Creditcoin network. It lets you generate inclusion proofs for transactions on supported source chains (e.g. Ethereum Sepolia) and verify them on-chain via Creditcoin's precompile contracts.

### Installation[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-sdk-usc-sdk\#installation)

Copy

```
npm install @gluwa/usc-sdk
# or
yarn add @gluwa/usc-sdk
```

The SDK requires [ethers.js v6](https://docs.ethers.org/v6/) as a peer dependency.

### Core concepts[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-sdk-usc-sdk\#core-concepts)

A **tra** _**n**_ **saction inclusion proof** answers the question: _"Did this transaction really happen on chain X?"_ It is made of two parts:

Part

What it proves

**Merkle proof**

The transaction is included in a specific block's transaction tree

**Continuity proof**

That block is part of a sequence of blocks anchored to an attestation point on Creditcoin

The SDK provides three main components you will work with:

- `ProofBuilder` — fetches pre-computed proofs from a hosted builder service (recommended starting point)

- `PrecompileChainInfoProvider` — queries attestation state from Creditcoin

- `PrecompileBlockProver` — submits proofs to Creditcoin's on-chain verifier


### Step by step guide[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-sdk-usc-sdk\#setting-up-providers)

First you'll need two JSON-RPC providers: one for the **source chain** (where the transaction happened) and one for **Creditcoin** (where proofs are verified).

Copy

```
import { JsonRpcProvider } from 'ethers';
import { chainInfo, blockProver, proofProvider } from '@gluwa/usc-sdk';

// Source chain (e.g. Ethereum Sepolia)
const sourceProvider = new JsonRpcProvider('https://sepolia.infura.io/v3/<api_key>'); //or other providers

// Creditcoin CC3 Testnet (CC3 Mainnet only once you are redy for production)
const creditcoinProvider = new JsonRpcProvider('https://rpc.cc3-testnet.creditcoin.network'); //or CC3 Tesnet RPC, https://rpc.cc3-testnet.creditcoin.network
```

#### Step 1: Query supported chains[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-sdk-usc-sdk\#step-1-query-supported-chains)

Use `PrecompileChainInfoProvider` to see which source chains are currently supported and find the `chainKey` for the chain you want to prove transactions from.

Copy

```
const chainInfoProvider = new chainInfo.PrecompileChainInfoProvider(creditcoinProvider);

const supportedChains = await chainInfoProvider.getSupportedChains();
console.log(supportedChains);
// [{ chainKey: 1, chainId: 11155111, chainName: 'Ethereum Sepolia', chainEncoding: 1 }, ...]
```

The `chainKey` is a Creditcoin-internal identifier for a source chain — it is **not** the same as the chain's EVM `chainId`. You will need it in every subsequent call.

#### Step 2: Wait for attestation[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-sdk-usc-sdk\#step-2-wait-for-attestation)

Before a proof can be generated, the block containing your transaction must be **attested** on Creditcoin. Attestation happens periodically and automatically; you just need to wait for it.

Copy

```
const txHash = '0x6fe777442b70a5511f3c443176ae860e50445bd93b663711717996a70c5022ab';
const chainKey = 1; // from Step 1

// Find which block the transaction is in
const tx = await sourceProvider.getTransaction(txHash);
const blockNumber = tx!.blockNumber!;

// We create a connection to the proof builder service. We listen
// for new attestations to be cached here rather than listening for
// them directly on-chain. This prevents request timing issues.
const proofBuilder = new proofProvider.service.ProofBuilder(
  chainKey,
  'https://prover.cc3-testnet.creditcoin.network',
  5000, // request timeout in ms (optional, default: 5000)
);

// Wait until Creditcoin has attested that block
await proofBuilder.waitUntilHeightAttested(chainKey, blockNumber);
console.log(`Block ${blockNumber} is attested — ready to generate proof`);
```

`waitUntilHeightAttested` polls the `proofBuilder` service at a configurable interval (default: `15s`) and resolves once the necessary attestation is present in the prover cache. It will throw after a configurable timeout (default: `15m`).

#### Step 3: Generate a proof with the Prover[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-sdk-usc-sdk\#step-3-generate-a-proof-with-the-proof-gen-api)

`ProofBuilder` is the simplest way to get a proof. It calls a hosted API that computes and caches proofs on your behalf — no RPC-heavy local computation required.

Copy

```
const result = await proofBuilder.getProof(txHash);

if (!result.success) {
  throw new Error(`Proof generation failed: ${result.error}`);
}

const proofData = result.data!;
console.log('Block number:', proofData.headerNumber);
console.log('Transaction bytes:', proofData.txBytes);
```

The returned `proofData` object contains everything needed for on-chain verification:

Field

Type

Description

`chainKey`

`number`

Source chain identifier

`headerNumber`

`number`

Block number the transaction was in

`txHash`

`string`

Transaction hash

`txBytes`

`string`

ABI-encoded transaction

`merkleProof`

`TransactionMerkleProof`

Siblings in the block's transaction Merkle tree

`continuityProof`

`ContinuityProof`

Chain of Merkle roots linking the block to an attestation

`cached`

`boolean`

Whether the proof was served from cache

#### Batch proof generation[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-sdk-usc-sdk\#batch-proof-generation)

If you need proofs for multiple transactions at once, use `getBatchProof`. All transactions in a batch share a single continuity proof, which makes on-chain batch verification more efficient. The current `MAX_BATCH_SIZE` is 10 proofs, and these must be within a `MAX_BATCH_RANGE` of 1000 blocks.

Copy

```
const batchResult = await proofBuilder.getBatchProof([txHash1, txHash2]);

if (!batchResult.success) {
  throw new Error(`Batch proof generation failed: ${batchResult.error}`);
}

const batchData = batchResult.data!;
```

#### Step 4: Verify the proof on-chain[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-sdk-usc-sdk\#step-4-verify-the-proof-on-chain)

`PrecompileBlockProver` submits proofs to Creditcoin's verifier precompile.

#### Single transaction[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-sdk-usc-sdk\#single-transaction)

Copy

```
const prover = new blockProver.PrecompileBlockProver(creditcoinProvider);

const verified = await prover.verifySingle(
  proofData.chainKey,
  proofData.headerNumber,
  proofData.txBytes,
  proofData.merkleProof,
  proofData.continuityProof,
);

console.log('Verification result:', verified ? 'SUCCESS' : 'FAILED');
```

#### Batch of transactions[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-sdk-usc-sdk\#batch-of-transactions)

When using batch proofs, you need to flatten the proof data into parallel arrays:

Copy

```
const headers: number[] = [];
const txBytesArr: string[] = [];
const merkleProofs = [];

for (const [headerNumber, proofsMap] of batchData.merkleProofs.entries()) {
  for (const [, proofEntry] of proofsMap.entries()) {
    headers.push(headerNumber);
    txBytesArr.push(proofEntry.txBytes);
    merkleProofs.push(proofEntry.merkleProof);
  }
}

const batchVerified = await prover.verifyBatch(
  batchData.chainKey,
  headers,
  txBytesArr,
  merkleProofs,
  batchData.continuityProof,
);

console.log('Batch verification result:', batchVerified ? 'SUCCESS' : 'FAILED');
```

### Complete end-to-end example[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-sdk-usc-sdk\#complete-end-to-end-example)

Copy

```
import { JsonRpcProvider } from 'ethers';
import { chainInfo, blockProver, proofProvider } from '@gluwa/usc-sdk';

async function proveTransaction(txHash: string) {
  // Resolve chain key
  const chainKey = 1; // Ethereum Sepolia on CC3 Testnet

  // Providers
  const sourceProvider = new JsonRpcProvider('https://sepolia.infura.io/v3/<api_key>'); //or other providers
  const creditcoinProvider = new JsonRpcProvider('https://rpc.cc3-testnet.creditcoin.network');

  const chainInfoProvider = new chainInfo.PrecompileChainInfoProvider(creditcoinProvider);
  const prover = new blockProver.PrecompileBlockProver(creditcoinProvider);
  const proofBuilder = new proofProvider.service.ProofBuilder(
    chainKey,
    'https://prover.cc3-testnet.creditcoin.network',
  );

  // Find block and wait for attestation
  const tx = await sourceProvider.getTransaction(txHash);
  await proofBuilder.waitUntilHeightAttested(chainKey, tx!.blockNumber!);

  // Generate proof via API
  const result = await proofBuilder.getProof(txHash);

  if (!result.success || !result.data) {
    throw new Error(`Proof generation failed: ${result.error}`);
  }

  const { chainKey: ck, headerNumber, txBytes, merkleProof, continuityProof } = result.data;

  // Verify on-chain
  const verified = await prover.verifySingle(ck, headerNumber, txBytes, merkleProof, continuityProof);
  console.log('Proof verification:', verified ? 'SUCCESS' : 'FAILED');

  return verified;
}
```

### Alternative: Raw proof generator[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-sdk-usc-sdk\#alternative-raw-proof-generator)

For advanced use cases where you need full control (e.g. running your own indexer, offline proof computation, or custom block providers), the SDK also ships a `RawProofBuilder` that computes proofs locally by fetching data directly from source chain RPCs.

Copy

```
import { EncodingVersion } from '@gluwa/usc-sdk/encoding';

const blockProvider = new proofProvider.raw.blockProvider.SimpleBlockProvider(sourceProvider);
const rawGenerator = new proofProvider.raw.RawProofBuilder(
  chainKey,
  blockProvider,
  chainInfoProvider,
  EncodingVersion.V1,
);

const result = await rawGenerator.getProof(txHash);
```

Both `RawProofBuilder` and `ProofBuilder` implement the same `ProofProvider` interface and produce identical output, so you can swap between them without changing any downstream code.

[PreviousOffchain Readability Workers](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure/offchain-readability-workers) [NextAttestcoin Protocol Chains - Environments](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-chains-environments)

Was this helpful?