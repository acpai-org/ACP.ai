---
url: "https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/attestor-operator-guide"
title: "Attestor Operator Guide | Attestcoin"
---

For the complete documentation index, see [llms.txt](https://docs.attestcoin.org/llms.txt). This page is also available as [Markdown](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/attestor-operator-guide.md).

During the initial launch phase of Attestcoin Protocol Readability, registering as an Attestor requires first party authorization. Eventually this role will be open to everyone. See the `Permissiveness` section for more details.

### Overview[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/attestor-operator-guide\#permissiveness)

This guide walks an **external operator** through running a single Creditcoin 3 (CC3) Attestor for **Ethereum Mainnet** on CC3 mainnet or testnet, while the attestation network is in `AuthorizedOnly` mode.

An Attestor is a component that watches a source chain (for example: Ethereum Mainnet), produces signed attestations about its blocks, and submits them to CC3. You do **not** need Kubernetes or the Creditcoin attestor-operator to run one. The Attestor is a single binary shipped in the `gluwa/creditcoin3` Docker image.

### Permissiveness[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/attestor-operator-guide\#permissiveness-1)

Attestor election operates under three possible modes:

Mode

Policy

`OpenToAny`

Any Attestor can be selected

`AuthorizedOnly`

Only authorized Attestors can be selected

`DeniedToAll`

No new Attestors can be selected

By default, all chain keys are created under the `OpenToAny` mode. In a production network, however, such as mainnet or testnet, chain keys will be operating under the `AuthorizedOnly` or `DeniedToAll` modes. This means that **for production networks, you will have to contact the Creditcoin team to be added to the on-chain set of authorized attestation entities**.

You can find a list of on-chain authorized Attestors by querying the `attestation/authorizedAttestors` storage item on the [chainstate](https://polkadot.js.org/apps/#/chainstate?rpc=wss://rpc.cc3-testnet.creditcoin.network) tab of polkadotjs. For networks operating under `OpenToAny`, this will return `null`.

Make sure to first get into contact with the Creditcoin team and that your Attestor address is part of the authorized set before trying to set up an Attestor against a production network.

### Attestor Setup Overview[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/attestor-operator-guide\#setup)

This section covers the following:

1. Prerequisites before you can set up an Attestor

2. An overview of the steps to set up an Attestor

3. The architecture decision of how to set up RPC endpoints for your Attestor


You will need two separate CC3 accounts:

- Attestor account - the "hot" key your node runs with. Its mnemonic goes in the node's config, and the same secret derives the node's BLS attestation key and libp2p identity. It only needs a small balance for fees.

- Stash account - holds the bonded funds and signs the administrative extrinsics (registerAttestor, chill, unregisterAttestor, withdrawUnbonded). Keep it as cold as possible; its mnemonic never touches the Attestor host.


The two must be different addresses. Step 1 below covers generating both.

**Prerequisites**

- A Linux host (or VM) with Docker installed. Reasonable starting resources for the Attestor alone: 2 vCPU, 2 GB RAM, a few GB disk for logs/identity. Running your own RPC nodes needs substantially more (see Step 2).

- Outbound network access, plus an **inbound** TCP port for libp2p P2P (default `9000`) so other Attestors can reach you.

- Access to the `gluwa/creditcoin3` Docker image. This image contains the binary for your Attestor. If you elect to run a Creditcoin 3 RPC node, it will also use this image. Use the same tag Creditcoin runs in production; see `Creditcoin Release Image` in the [per-chain settings](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/per-chain-attestor-settings).

- A way to sign extrinsics on CC3 mainnet or testnet: the Polkadot.js Apps UI connected to a CC3 mainnet RPC is the simplest. Import your Attestor mnemonic into the Polkadot.js browser extension. A link to the Polkadot.js App UI for your desired chain can be found in the [per-chain settings](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/per-chain-attestor-settings) table

- (Optional) `subkey` or Node.js for generating the account offline.


**Setup Steps Overview**

1. Generate an sr25519 account (mnemonic + SS58 address)

2. Stand up / choose your CC3 + Ethereum RPC endpoints

3. Fund the account with at least 10 CTC

4. Send your SS58 address to the Creditcoin team -> they `authorize_attestor(chainKey, you)` \[AuthorizedOnly\]

5. Use your stash account to submit `register_attestor(chainKey, you)` -\> status: Idle

6. Start the Attestor node; it auto-submits `attest()` -\> status: Waiting

7. Next election/epoch rotation promotes you -> status: Active

8. Your node commits attestations and earns rewards


**Initial Decision: Which RPC Endpoints to Use**

An Attestor needs **two** independent RPC connections:

Connection

Used for

Config key

**CC3 RPC** (WebSocket)

Listening to CC3 events/storage and submitting attestation extrinsics

`cc3.url` / `--cc3-url` / `ATTESTOR_CC3_URL`

**Ethereum Mainnet RPC** (WebSocket)

Pulling source-chain block data and generating continuity proofs

`eth.url` / `--eth-url` / `ATTESTOR_ETH_URL`

The two connections are independent, and they have different options:

- **Creditcoin 3 RPC** \- you can either use Creditcoin's public CC3 RPC or run your own CC3 node.

- **Ethereum Mainnet RPC** \- this must come from an external source, since Creditcoin does not run a public Ethereum RPC for external Attestors. You can use a commercial provider or run your own Ethereum node.


See Step 2 for how to set up each of these.

> **Recommendation:** Attestors are explicitly _advised to run their own RPC servers_ (it's noted directly in the Attestor's own config template). A shared public endpoint is rate-limited and is a single point of failure for your liveness. Use Creditcoin's public CC3 RPC to validate your setup, then move to your own node for production.

### Attestor Setup Steps[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/attestor-operator-guide\#attestor-setup-steps)

**Step 1: Generate your Attestor account**

The Attestor signs with an **sr25519** key. The account's SS58 address is what gets authorized, registered, and funded on-chain. The _same_ secret is also used to derive the node's BLS attestation key and libp2p identity automatically, so you only ever provide the one secret.

Pick any **one** method:

**Option 1: Polkadot.js browser extension.** Create a new account, choosing the `sr25519` (default) type, and back up the seed phrase.

**Option 2:**`subkey` **(simplest, if you already have subkey installed):**

Copy

```
subkey generate --scheme sr25519
```

Record the **secret phrase** (mnemonic) and the **SS58 Address**.

**Option 3: offline Node.js snippet** (prints the address derived from a fresh mnemonic):

Copy

```
node --input-type=module -e '
import { mnemonicGenerate, cryptoWaitReady } from "@polkadot/util-crypto";
import { Keyring } from "@polkadot/keyring";
await cryptoWaitReady();
const mnemonic = mnemonicGenerate();
const address  = new Keyring({ type: "sr25519" }).addFromMnemonic(mnemonic).address;
console.log(JSON.stringify({ mnemonic, address }, null, 2));
'
```

**For All Step 1 Options:**

> **Keep the mnemonic secret and backed up.** It controls your funds and your Attestor identity. The Attestor accepts either a BIP-39 mnemonic or a raw `0x`-prefixed 32-byte hex seed as its secret. If you start the node with **no** secret, it generates a random one on each start. Never do this for a real Attestor.

Repeat this address creation step for your stash account. Your Attestor account and stash account must be different addresses!

The key idea of a stash account is **separation of concerns**:

- **Stash account**: Holds the actual funds being staked. It's meant to stay as secure as possible - ideally a cold or rarely-used key - because it controls a large amount of value.

- **Attestor controller account**: Used for day-to-day Attestor operations (starting/stopping attestation, setting preferences, etc.). It doesn't hold significant funds, so it can be a "hot" key used more frequently without much risk.


**Step 2: RPC Endpoints Setup**

An Attestor needs **two** RPC endpoints: one for **Creditcoin 3** and one for **Ethereum Mainnet**. Set up each one as described below.

**Recommendation:** Attestors are explicitly _advised to run their own RPC servers_ (it's noted directly in the Attestor's own config template). A shared public endpoint is rate-limited and is a single point of failure for your liveness. Use Creditcoin's public CC3 RPC to validate your setup, then move to your own node for production.

**Creditcoin3 RPC**

You have two options:

_Option A - Use Creditcoin's public CC3 RPC._ No setup necessary! When you spin up your Attestor in Step 6, point it at Creditcoin's public CC3 RPC corresponding to the network you're joining. These are found in the [per-chain settings](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/per-chain-attestor-settings) table.

> Public endpoints are shared and rate-limited. Fine for bring-up and testing; for production, prefer running your own node (Option B).

_Option B - Run your own CC3 node._

If using this guide for an Attestor on CC3 Testnet, this option is unsupported.

To run a CC3 mainnet RPC node, see the RPC Guide.

You can remove the following parameters when launching your RPC node, as it is only serving your Attestor, rather than the public.

- --prometheus-external

- --telemetry-url

- --public-addr

- --pruning archive


Notes:

- Wait for the node to fully sync before relying on it. The Attestor will connect over `ws://<host>:9944`.

- The current production bootnode(s) are published in the Creditcoin environment pages (they may rotate). See the [environment documentation](https://docs.creditcoin.org/environments/mainnet) for the up-to-date list.


**Ethereum Mainnet RPC**

The Ethereum Mainnet RPC must come from an external source - Creditcoin does not run a public Ethereum RPC for external Attestors. You'll need to find a provider of Ethereum Mainnet RPC with a rate limit that allows the volume of calls your Attestor makes. The Attestor connects over a **websocket (wss)** endpoint. Either:

- Use a commercial provider (Alchemy, Infura, Chainstack, QuickNode, etc.) and use its websocket (wss) endpoint, **or**

- Run your own execution client (e.g. Geth/Erigon/Nethermind) and expose its WS endpoint (e.g. `ws://<eth-host>:8546`).


If the Creditcoin team shares an Ethereum endpoint with you, use that value for `eth.url` instead.

The Attestor reads historical block data and builds continuity proofs, so the endpoint must serve the block ranges you attest over. A full node with adequate history (or a provider plan that allows historical lookups) is required.

**Expected call volume:**

- Initial sync: burst of ~50–100 req/s until caught up (2 requests per block, max 20 concurrent). Rule of thumb: 1 day of backlog clears in ~5 minutes.

- Normal day: ~15,000 requests/day (~10 req/min - 2 requests per new block), plus 2 WebSocket newHeads subscriptions (WS support required).

- Peak: capped at 20 concurrent requests by design; worst case ~100–200 req/s on a low-latency endpoint during catch-up.


> Your endpoints for the Attestor config (Step 6): `cc3.url = <public-creditcoin-rpc>` (Option A) or `ws://<your-cc3-host>:9944` (Option B) `eth.url = <provider wss endpoint>` or your own node's `ws://<your-eth-host>:8546`

**Step 3: Fund your account**

The Attestor checks its balance at startup and **refuses to run** if the free balance is below the minimum:

- **Minimum required: 1 CTC** (this is a hard check in the binary; below it, the node logs `⛔ Attestor has insufficient balance` and exits).


In this step, you fund **two** accounts:

- **Attestor account:** send at least **10 CTC**(minimum required **1 CTC** plus a few extra to cover the transaction fees), to your Attestor's SS58 address from any funded CC3 account you control, e.g., via Polkadot.js Apps → _Accounts → Transfer_, or the `balances.transferKeepAlive(dest, amount)` extrinsic.

- **Stash account:** fund it with at least `MinBondRequirement` (see the hint below).


> Ongoing cost is low: successful attestation submissions from an active Attestor have their fee **refunded**, so your balance mainly needs to stay above the 1 CTC floor and cover the occasional non-refunded fee.

Your stash account must have a balance greater than `MinBondRequirement`. Currently the `MinBondRequirement` for attesting to `EthMainnet` on `CC3 Mainnet` is 0. But in the future when the Attestor set is permissionless, that number will be set sufficiently high to economically secure the network. Still, the stash account must have at least enough funds to pay for the `registerAttestor` extrinsic.

On `CC3 Testnet` the `MinBondRequirement` to attest to `EthMainnet` is 100 CTC. The public testnet faucet grants 10,000 CTC, which is more than enough to fund both accounts.

**Step 4: Get your account authorized (AuthorizedOnly)**

Since the network uses the `AuthorizedOnly` election policy for this chain, your account must be on the on-chain allow-list **before** it can register or be elected. Authorization is gated behind the Creditcoin team's operator/governance origin (`attestation.authorize_attestor`). **You cannot do this step yourself.**

**Action:** send the Creditcoin team the following and ask them to authorize you:

- Your Attestor **SS58 address** (from Step 1).

- The **chain key** you intend to attest for. You can find this in the [per-chain settings](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/per-chain-attestor-settings) table


The Creditcoin team (sudo/governance) will execute:

For the following command, <eth-mainnet-chain-key> is found in the [per-chain settings table](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/per-chain-attestor-settings)

`attestation.authorize_attestor(chainKey = <eth-mainnet-chain-key>, attestorId = <your SS58 address>)`

You can confirm it landed by checking on-chain storage (Polkadot.js Apps → _Developer → Chain state_):

For the following storage entry, <eth-mainnet-chain-key> is found in the [per-chain settings table](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/per-chain-attestor-settings)

`attestation.authorizedAttestors(<eth-mainnet-chain-key>, <your SS58 address>)`

A returned entry (rather than empty) means you're authorized. You can also watch for the `attestation.AuthorizedAttestorAdded(<eth-mainnet-chain-key>, <your address>)` event.

> If you skip this step, your `register_attestor` call in Step 5 will fail with `NotPreAuthorizedToRegister`, and even if you were already registered, the election will silently skip you because you aren't authorized.

**Step 5: Register your Attestor on-chain**

You perform this step yourself, signing with your Attestor stash account. Registration puts your account into the Attestor set with status `Idle`.

When you call `registerAttestor`, the calling account becomes the `stash` address of your Attestor. If the calling account doesn't have at least `MinBondRequirement` funds, then your `registerAttestor` call will fail.

1. Go to Polkadot.js Apps → _Developer → Extrinsics_

2. In the account dropdown at the top, select your stash account - the calling account becomes the Attestor's stash

3. Select attestation in the left dropdown and registerAttestor in the right dropdown

4. Fill in the parameters: chainKey = (per-chain settings table), attestorId = your Attestor account's SS58 address

5. Submit and sign the transaction


For the following command, <eth-mainnet-chain-key> is found in the [per-chain settings](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/per-chain-attestor-settings) table

`attestation.registerAttestor(chainKey = <eth-mainnet-chain-key>, attestorId = <your SS58 address>)`

Verify registration (Polkadot.js Apps → _Developer → Chain state_):

`attestation.attestors(<eth-mainnet-chain-key>, <your SS58 address>)`

A non-empty entry with `status: Idle` means you're registered and ready to run the node.

> Order tip: you can register any time **after** authorization (Step 4) and **after** funding (Step 3). The node itself does not call `register_attestor` for you; it only takes over from the `Idle` state onward.

**Step 6: Configure and run the Attestor**

The Attestor reads configuration in this priority order: **CLI args > environment variables > config file** (`config.yaml`).

Create `config.yaml`:

To fill in <eth-mainnet-chain-key> and <public-creditcoin-rpc> consult the [per-chain settings](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/per-chain-attestor-settings) table

To fill in <attestor-boot-node-addr>, ask your contact on the Creditcoin team. Attestor bootnodes aren't public yet. When you ask, specify whether you are setting up an Attestor for CC3 Mainnet or CC3 Testnet.

Copy

```
attestor:
  name: "my-attestor"
  chain_key: <eth-mainnet-chain-key>     # Ethereum Mainnet on CC3 mainnet or CC3 Testnet
  secret: "<your 12/24-word mnemonic>"   # or a 0x-prefixed 32-byte hex seed

api:
  port: 9100

p2p:
  port: 9000
  no_mdns: true                      # recommended outside a local network
  boot_nodes:
    # Ask the Creditcoin team for this. See hint above.
    - "<attestor-boot-node-addr>"

eth:
  # External provider websocket (wss), or your own node, e.g. ws://eth-host:8546
  url: "<ethereum-mainnet-rpc>"

cc3:
  # Option A: <public-creditcoin-rpc>
  # Option B: your own node, e.g. ws://<your-cc3-host>:9944
  url: "<public-creditcoin-rpc>"
```

Run it:

To fill in <release-image>, see the [per-chain settings](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/per-chain-attestor-settings) table

Copy

```
docker run -d --name cc3-attestor \
  --entrypoint /bin/attestor \
  -p 9000:9000 \
  -p 9100:9100 \
  -v "$PWD/config.yaml:/config.yaml:ro" \
  -v "$PWD/logs:/logs" \
  -v "$PWD/data:/data" \
  gluwa/creditcoin3:<release-image> \
  --config /config.yaml --logs /logs
```

**P2P reachability:** make sure your P2P port (`9000`) is reachable from the internet (firewall/security-group inbound rule, and a port mapping if behind NAT). If you set a stable public hostname/IP, pass it via `public_addr` / `--public-addr` / `ATTESTOR_PUBLIC_ADDRESS` so peers can dial you back.

**Boot node:** the multiaddr in `config.yaml` above is an example of the shared Eth-Mainnet Attestor bootnode. Confirm the **current** value with the Creditcoin team before relying on it. Without a reachable boot node your Attestor can't discover peers.

**Step 7: Verify it's working**

1. **Watch the logs.** On a correctly funded, authorized, registered Attestor you should see, in order:


- `🔍 Attestor has sufficient balance`

- `📝 Submitting attest() extrinsic to transition from Idle to Waiting`

- `✅ Successfully submitted attest() - now Waiting for election`

- `⏲️ Waiting for attestor to be made eligible`

- Then (after the next election) it begins producing/committing attestations.


Copy

```
docker logs -f cc3-attestor
```

1. **Check on-chain status** (Polkadot.js Apps → _Developer → Chain state_):


For the following command <eth-mainnet-chain-key> is found in the [per-chain settings](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/per-chain-attestor-settings) table

Copy

```
attestation.attestors(<eth-mainnet-chain-key>, <your SS58 address>)
```

Status transitions you should expect: `Idle` → `Waiting` → `Active`.

After your Attestor is running and has marked itself as `Waiting` it won't be added to the active set until the end of the current epoch. Epochs last 12 hours on Creditcoin 3. You can see the current time until the next epoch on the Polkadot.js Apps explorer (Network → Explorer) for your network - use the RPC for your chain from the [per-chain settings](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/per-chain-attestor-settings) table.

You can also check the active set:

For the following command <eth-mainnet-chain-key> is found in the [per-chain settings](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/per-chain-attestor-settings) table

Copy

```
attestation.activeAttestors(<eth-mainnet-chain-key>)     # your address appears once Active
```

1. **Query the metrics endpoint** (the API port you exposed):


Copy

```
curl http://localhost:9100/metrics
```

If you reach `Waiting` but never `Active`, the most common cause under `AuthorizedOnly` is that authorization (Step 4) didn't complete, or an election hasn't run yet. Elections happen at epoch boundaries.

### Attestor lifecycle reference[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/attestor-operator-guide\#attestor-lifecycle-reference)

State

Meaning

How you reach it

_(not registered)_

No on-chain Attestor entry

n/a

`Idle`

Registered, but not signaling readiness

`register_attestor` (Step 5)

`Waiting`

Signaled readiness (BLS key + proof submitted), awaiting election

The **node** auto-submits `attest()` on startup

`Active`

Elected; committing attestations and earning rewards

Election promotes a `Waiting` **authorized** Attestor

`Leaving`

Voluntary chill scheduled

`chill`

Key point: **the node only automates the**`Idle` **→**`Waiting` **transition** (it submits the `attest()` extrinsic with your BLS public key and proof of possession). Everything before `Idle` (authorize, register, fund) is done out-of-band, as described above.

To stop attesting cleanly:
1\. Submit `attestation.chill(<eth-mainnet-chain-key>, <your address>)` from your Attestor stash account. If your Attestor was Active, it moves to Leaving and becomes Idle at the next epoch boundary (epochs last 12 hours); if it was only Waiting, it becomes Idle immediately.
2\. Once status shows Idle, stop the Attestor container.
3\. (Optional) If you don't intend to restart your Attestor then call `attestation.unregister_attestor(<eth-mainnet-chain-key>, <your address>)` from your stash account.
5\. Finally, you can withdraw your stash by calling `attestation.withdraw_unbonded()` \- No parameters - from your stash account. Look for the attestation. Withdrawn event to confirm that the funds have been released.

### Configuration reference[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/attestor-operator-guide\#configuration-reference)

Config file

CLI flag

Env var

Req.

Default

Notes

`attestor.name`

`--name`

`ATTESTOR_NAME`

Yes

n/a

Display/debug name

`attestor.chain_key`

`--chain-key`

`ATTESTOR_CHAIN_KEY`

Yes

n/a

See [per-chain settings](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/per-chain-attestor-settings) table

`attestor.secret`

`--secret`

`ATTESTOR_SECRET`

No

random

BIP-39 mnemonic or `0x` 32-byte hex seed. Always set it for a real Attestor

`attestor.public_addr`

`--public-addr`

`ATTESTOR_PUBLIC_ADDRESS`

No

OS-assigned

Stable public address peers dial back

`attestor.logs`

`--logs`

`ATTESTOR_LOGS`

No

`./logs`

Log folder

`api.port`

`--api-port`

`ATTESTOR_API_PORT`

No

`9100`

`/metrics` endpoint

`p2p.port`

`--p2p-port`

`ATTESTOR_P2P_PORT`

No

`9000`

libp2p listen port (open it!)

`p2p.boot_nodes`

`--boot-nodes`

`ATTESTOR_BOOT_NODES`

No

none

Peer discovery; get from the Creditcoin team

`p2p.no_mdns`

`--no-mdns`

`ATTESTOR_NO_MDNS`

No

false

Disable local mDNS discovery

`eth.url`

`--eth-url`

`ATTESTOR_ETH_URL`

Yes

n/a

Ethereum Mainnet WS RPC

`cc3.url`

`--cc3-url`

`ATTESTOR_CC3_URL`

Yes

n/a

CC3 mainnet WS RPC

`attestation.start_height`

`--start-height`

`ATTESTOR_START_HEIGHT`

No

chain genesis

Override first source height

`attestation.interval`

`--attestation-interval`

`ATTESTOR_ATTESTATION_INTERVAL`

No

on-chain value

Override attestation interval

By default the Attestor masks RPC URLs in its logs to avoid leaking API keys. Pass `--expose-urls-in-logs` only when debugging in a private environment.

**Verifying the chain key**

Chain keys are assigned when a source chain is registered on-chain, so confirm the value for Ethereum Mainnet before configuring `chain_key`. In Polkadot.js Apps → _Developer → Chain state_, inspect the `supportedChains` pallet storage (the registered chains list) and match Ethereum Mainnet's chain ID (`1`) to its chain key. The chain key depends on which CC3 chain you are running your Attestor on. The current chain keys for Ethereum Mainnet are found in the [per-chain settings](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/per-chain-attestor-settings) table.

### Troubleshooting[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/attestor-operator-guide\#troubleshooting)

`⛔ Attestor has insufficient balance` **(and the node exits)**

Your free balance is under 1 CTC. Top up the account (Step 3) and restart. We recommend keeping ~10 CTC so that occasional non-refunded fees never drop you below the floor.

`register_attestor` **fails with**`NotPreAuthorizedToRegister`

Your account isn't authorized yet. Complete Step 4 with the Creditcoin team, confirm `attestation.authorizedAttestors(<eth-mainnet-chain-key>, <your SS58 address>)` is populated, then retry registration.

`register_attestor` **fails with**`AlreadyAttestor`

You're already registered for this chain key. Skip to running the node.

**Node logs**`Attestor status is already ..., skipping attest()`

The node only submits `attest()` from the `Idle` state. If status is `None` (not registered) it won't register for you; go do Step 5. If it's already `Waiting`/`Active`, this is normal.

**Stuck at**`Waiting` **, never**`Active`

Either no election has run yet (they occur at epoch boundaries; wait for the next one), or your account is registered but **not authorized** (re-check Step 4). Under `AuthorizedOnly`, unauthorized `Waiting` Attestors are skipped at election time.

**No peers / P2P connection issues**

Confirm your P2P port (`9000`) is open inbound, the boot node multiaddr is the current one from the Creditcoin team, and (if behind NAT) you've set `public_addr` to a reachable hostname/IP.

**RPC connection errors**

Verify the `cc3.url` and `eth.url` endpoints are reachable from the container and are **WebSocket** URLs (`ws://` / `wss://`). If you are using a public endpoint, you may be hitting rate limits; consider moving to your own node.

### Quick summary checklist[Direct link to heading](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/attestor-operator-guide\#quick-summary-checklist)

- Generate sr25519 account; back up mnemonic (Step 1)

- Set up RPC endpoints: Creditcoin's public CC3 RPC or your own CC3 node, plus an external Ethereum Mainnet RPC (Step 2)

- Fund the Attestor account with at least ~10 CTC (hard minimum 1 CTC), and the stash account with atleast `MinBondRequirement` (Step 3)

- Send your SS58 address and the chain key from the per-chain settings table to the Creditcoin team for authorize\_attestor (Step 4). Only Ethereum Mainnet is supported at the time of writing.

- Submit `register_attestor(<eth-mainnet-chain-key>, <your SS58 address>)` yourself (Step 5)

- Run the Attestor container with your config (Step 6)

- Confirm `Idle` → `Waiting` → `Active` and a healthy `/metrics` (Step 7)


[PreviousAttestcoin Protocol Operator Guides](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides) [NextPer-chain Attestor Settings](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-operator-guides/per-chain-attestor-settings)

Was this helpful?