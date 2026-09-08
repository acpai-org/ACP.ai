
<p align="center">
  <img src="./public/pics/acpai.png" width="700" />
</p>

<div align="center">

![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?style=for-the-badge&logo=nextdotjs&logoColor=white)
![React 19](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Tailwind CSS 4](https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)
![wagmi v3](https://img.shields.io/badge/wagmi-v3-8A2BE2?style=for-the-badge)
![viem 2](https://img.shields.io/badge/viem-2-1B1B1F?style=for-the-badge)
![Solidity](https://img.shields.io/badge/Solidity-0.8.36-363636?style=for-the-badge&logo=solidity&logoColor=white)
![Zod](https://img.shields.io/badge/Zod-3-3E67B1?style=for-the-badge&logo=zod&logoColor=white)

</div>

## Table of Contents
- [ACP.ai](#acpai)
- [Features](#features)
- [Screenshots](#screenshots)
- [Supported Chains](#supported-chains)
- [Installation](#installation)
- [Full Architecture](#full-architecture)


> [!NOTE]
> Demo video/links are in progress and will be published soon.
> 


# ACP.ai
This project was built with the goal of simplifying the world of web2/web3 for crypto enthusiasts. Doesn't matter if you are a complete beginner, know some stuff about crypto or are an advanced professional; this project is for anyone who is brave enough to step into the world of crypto.



And there is always a gap between the current LLMs and the applications you use. And we closed that for crypto.



Say you want to make an entire token and deploy it on-chain, write a complex contract that does something big you have in mind. You can always use ChatGPT or its competitors, but it's truly a deep hassle for a beginner and time consuming for the normal person. Hallucinations, outdated data, etc. All of that will stop you before long.



Or maybe you just want to automate something. Set up conditional actions. Say you wanted to, for instance, every Saturday, swap a specific token and instantly send it to an address. Or if you spend too much of something, you wanna get reminded you are spending too much.
With our application, you can set all that up in mere seconds. You're in control of everything.



And that raises another problem. What if you want to prove what you did? Not a screenshot. Not a "trust me, man." A real, cryptographic proof that your payment was settled. And that is where Attestcoin enters.


### But why Attestcoin?
A transaction hash is not proof. It's like a pointer - a promise that if you go look, you *might* just find something. Screenshots can be faked, databases can be edited. Basically, it is not a proof.


Attestcoin solves this properly. It is a protocol on Creditcoin that produces attestations - cryptographic evidence; Merkle proofs plus continuity proofs, proving that your transaction on the source chain really happened and really succeeded. And importantly, the verification doesn't run on our servers at all. It runs on the Creditcoin chain itself, a **decentralized** financial infrastructure that enhances trust through secure and transparent credit transactions. It utilizes blockchain technology to record these transactions, ensuring integrity and transparency. No one can forge or revoke it. 


ACP.ai wires the whole protocol into your actions, automatically. With certificates that anyone can verify (Export any verified payment as a certificate or QR code). 

## Features

- **Prioritized User Experience** - On UI/UX
- **Cross-chain escrow & contract deployment** - In-house Solidity ASC contracts (Deployable via the Agent) and Agent-driven deployment
- **Payments, recurring & automation** - Send tokens to addresses, swap assets, Automate actions
- **Multi-Chain integration** - Our application allows for actions across multiple chains
- **Closed 24-tool registry** - a fixed set of 24 vetted actions the agent can call, each with per-tool Zod schemas, JSON Schema for the model, and risk classes, etc
- **Skills** - 11 built-in skills. With the ability to add more for the agent.
- **Prioritized Security** - All data is local. No telemetry, no auth-service and no built-in provider. (For now)
- **BYOK** - You can bring your own api keys and use our service purely locally
- **Desktop and Mobile** - You can use our app on different devices
- **Multilingual** - Supports English, Korean, Chinese and Japanese. (beta)
- **Live execution trace UI** - view whatever the agent is doing as it happens, in human readable data instead of raw logs
- **Dark and Light themes** - Used for customization

### Security model

what this app will never do:

- No move without signature
- Everything happens locally
- Keys never leave browser/server


## Screenshots

How our project's overall UI currently looks like. 

<details>
<summary><b>Screenshots</b></summary>
<br>

<details>
<summary><b>Desktop</b></summary>
<br>

### Homepage
This is the main page where users can talk with the Agent.

<p align="center">
<img src="./public/pics/mainpage-desktop.svg" width="700" />
</p>

### Wallet

<p align="center">
<img src="./public/pics/walletpage-desktop.svg" width="700" />
</p>

</details>

<br>

<details>
<summary><b>Phone</b></summary>
<br>

### Homepage
This is the main page where users can talk with the Agent.

<p align="center">
<img src="./public/pics/mainpage-android.svg" width="350" />
</p>

### Wallet

<p align="center">
<img src="./public/pics/walletpage-android.svg" width="350" />
</p>

</details>

</details>


## Supported Chains

| Chain | ID |
|---|---|
| Creditcoin Testnet (CC3) | 102031 |
| Creditcoin Mainnet (CC3) | 102030 |
| Ethereum Sepolia | 11155111 |
| Ethereum | 1 |
| BNB Smart Chain | 56 |
| Base | 8453 |
| Arbitrum One | 42161 |
| Optimism | 10 |
| Polygon | 137 |


## Installation

### Prerequisites

- bun for installation
- A wallet (MetaMask, TrustWallet, etc.), preferably funded with tCTC (test CTC) or for mainnet, real CTC.<br>
  based on whether you want to use the signing on Attestcoin.
- An AI provider API key (ChatGPT, Z.ai, Kimi or any OpenAI-compatible endpoint)

Run this in a terminal (Git Recommended. Use termux for android.)

```
git clone https://github.com/acpai-org/ACP.ai/
bun install
```
Now must set the .env and after that, build, and then you are set to go.

Run ```cp .env.example .env```, open .env and do these:
```
NEXT_PUBLIC_WC_PROJECT_ID=efee3824eaa92fa34351c5d64ce0ecef  # Default; do not touch unless you want to use your own.
ATTESTCOIN_NETWORK=testnet    # Or use mainnet
CREDITCOIN_SIGNER_KEY=<a tCTC funded wallet's private key>   # Optional. Do not use your main wallet's private key here, simply create a new wallet, use the official CreditCoin faucet at their discord, and get some test CTC. You can use a real CTC funded wallet too, but that is for mainnet. So be careful.
```
Your .env should have these settings.

### *Optional*
*For submitting proof on Attestcoin, you must get a real wallet's private key, funded with CTC (or tCtc if on testnet) to do actions requiring it;*
*Then set it at `CREDITCOIN_SIGNER_KEY=` as shown above.*

Lastly, simply built and run the app with:
```
bun run build
bun run start
```


## Full Architecture

<details>
<summary><strong>Full architecture reference</strong> (click to expand)</summary>

What runs where:

- **Browser**: the UI, the wallet, and the AI provider settings (endpoint,
  model, API key; the key stays in the browser).
- **Server**: the agent loop, tool execution, the API routes, SQLite via
  drizzle, and the Attestcoin poller.
- **External**: your OpenAI-compatible model endpoint, the EVM chains, and
  the Creditcoin attestation network.

A run flows like this: the user sends a message, the server loop calls the
model, tool calls dispatch either in-process (server tools) or to the
browser wallet (client tools), results feed back to the model, and the whole
run streams to the UI as NDJSON events. Payments settle on-chain; the
poller later attests them on Creditcoin.

Sections 1–4 cover the agent core and its on-chain integrations, 5–6 the
persistence and HTTP layers, 7 the browser side, and 8–9 operations and
security.

### 1. Agent core (`src/lib/agent/`)

All agent behavior runs through one tool-calling loop over a closed tool
registry.

#### 1.1 The loop (`loop.ts`)

A tool-calling loop, not single-shot chat:

```
user message
  → model (your OpenAI-compatible endpoint)
  → 0..N tool calls                    ── only registry names survive
  → each call dispatched:
       server tool   → executed in-process (reads, config)
       client tool   → emitted as tool_call_request → browser wallet
  → results fed back to the model
  → repeat (≤ 8 rounds) until the task resolves or needs the user
```

Boundaries are enforced in the loop, not left to convention:

1. Unknown tool names are rejected and logged, never interpreted.
2. Contract deployments always show the confirmation card first (source or
   template plus a plain-English summary) before anything goes on-chain.
3. Routine fund moves are confirmed by the wallet signature itself. The app
   adds no second "are you sure" layer; the trace shows the concrete
   details before and during signing.
4. Every action lands in the persistent action log with its proof
   references (tx hash, contract address, Merkle root).

Timeouts bound the loop: 10 minutes per tool result, 5 minutes per
confirmation, at most 8 rounds. A browser disconnect aborts the run and
marks pending steps `interrupted`; on-chain transactions finish
independently, and the log catches up from the receipt.

#### 1.2 Tool registry (`tool-registry.ts`): 28 tools

Each tool is a `ToolDef`:

```ts
{ name, description, parameters (JSON Schema), zod (runtime), executor,
  risk: "read"|"funds"|"deploy"|"config"|"privilege", confirmationRequired? }
```

Grouped by risk:

| Risk | Tools | Executor |
| --- | --- | --- |
| read | `get_balances`, `get_transaction_status`, `check_attestation_status`, `wait_for_attestation`, `attestcoin_network_status`, `list_contacts`, `list_chains`, `list_recent_actions`, `list_automation_rules`, `list_recurring_payments`, `decode_source_transaction`, `verify_proof_readonly`, `estimate_verification_cost`, `get_attestation_bounds`, `get_app_status` | server |
| funds | `transfer`, `batch_transfer`, `create_recurring_payment`, `cancel_recurring_payment` | client (wallet) |
| deploy | `deploy_contract`, `create_conditional_release`, `execute_conditional_release`, `cross_chain_swap` | client; always confirmed |
| config | `create_contact`, `create_automation_rule`, `update_automation_rule`, `delete_automation_rule`, `submit_proof_onchain` | server (`submit_proof_onchain` uses the opt-in server signer) |

Design principle: few, rich tools. One `transfer` tool with chain and token
parameters beats five near-duplicates. Every fund-moving tool is
chain-parameterized across the active chain set, and the chain-id schema
tells the model to ask when the chain is ambiguous rather than guess.

#### 1.3 Two executors, one contract

**Server tools** (`server-tools.ts`) are pure reads and configuration: they
run in the Node process, write through drizzle, and return JSON.

**Client executors** (`client-executors.ts`) are the wallet half. The server
validates the intent (zod); the browser converts it into a specific, known
transaction shape:

| Tool | Transaction shape |
| --- | --- |
| `transfer` (native) | `sendTransaction` |
| `transfer` (ERC-20) | `writeContract transfer(...)` |
| `batch_transfer` | sequential transfers |
| `deploy_contract` | `deployContract(server-compiled bytecode)` |
| `create_conditional_release` | deploy + escrow value in one tx |
| release/swap tools | `writeContract release(...)` |

The model never supplies transaction bytes. For auto chain-switching, every
executor awaits `switchChain` to the tool's target chain (silent where the
wallet supports it) before signing.

#### 1.4 Streaming protocol (NDJSON)

`POST /api/agent/run` opens a streaming response that stays open for the
whole run. Events, one JSON object per line:

- `text_delta`: streamed assistant prose.
- `trace`: live step updates (status: pending → awaiting_signature →
  broadcast → confirming → succeeded/failed).
- `tool_call_request`: dispatch to the browser wallet.
- `confirmation_request`: the deploy confirmation card.
- `run_end`: terminal.

The browser answers dispatches and confirmations on
`POST /api/agent/respond`; an in-memory session registry (`session.ts`)
bridges the two requests by run and call id. This two-channel design keeps
the fund-moving authority in the browser while the loop (pagination,
retries, model I/O) stays on the server.

#### 1.5 Retry semantics

History entries can carry prior tool calls and results. When the user hits
"retry", the loop maps completed steps to the LLM's tool role, so the model
sees what already succeeded and re-runs only the failed step instead of
repeating the whole turn (and, for example, double-paying).

#### 1.6 Fees and gas

`fee-estimate.ts` and `gas-live.ts` estimate gas from the exact transaction
shape via live RPC `estimateGas`; never a constant. Token prices are never
invented: the product deliberately shows no USD valuations anywhere, so it
can never display a stale price.

#### 1.7 Skills and policy

- **Skills** (`src/lib/skills.ts`, `/api/skills`): named instruction packets
  the user can enable or disable, optionally scoped to a tool allowlist
  validated against the registry. A stored allowlist whose tools have all
  been removed serializes as an empty list, never as "all tools".
- **Policy** (`policy.ts`, `/api/agent/policy`): mainnet deploy opt-in
  (default off), custom-deploy warning dismissal, and the active chain set.

### 2. Wallet and chains layer (`src/lib/wagmi/`, `src/lib/chains/`)

- **Chain registry** (`chains/registry.ts`) is the single source of truth:
  Creditcoin TN (102031), Creditcoin (102030), Sepolia (11155111), Ethereum,
  Base, Arbitrum, OP, Polygon, BNB, and more. Viem chain objects, RPC
  endpoints, explorers, and token lists all derive from it. The agent's
  `list_chains` tool, the chain switcher, and the wallet page all read the
  same registry.
- **AppKit init** (`appkit-init.ts`, `provision.ts`): Reown AppKit with the
  wagmi adapter; the WalletConnect project id comes from
  `NEXT_PUBLIC_WC_PROJECT_ID`.
- **Provisioning** (`provision.ts`): active chains from the policy's
  `activeChainKeys` are added to the wagmi config at runtime, so
  chain-switching works even for chains the wallet does not know yet.

### 3. Attestcoin pipeline (`src/lib/attestcoin/`)

Payments get cryptographic receipts attested by the Creditcoin chain. The
flow, end to end:

1. **Payment settles** on a source chain (e.g. Sepolia); the row records
   `tx_hash` and `settled_at`.
2. **Poller** (`poller.ts`, 60-second interval): watches settled payments
   without attestation. When the hosted Proof Builder first serves a Merkle
   and continuity proof for the transaction, it:
   - persists `attested_at` and `attest_root` with a conditional UPDATE, so
     notifications fire only when this tick flipped the row;
   - asks the Block Prover Precompile (0x0FD2) to verify the proof on-chain
     via a read-only `eth_call` (no signer), recording `onchain_verified_at`;
   - fires the "attested" notification, localized at render time.
3. **Submission** (`submit.ts`) is user-initiated only:
   `submit_proof_onchain` runs `verifyAndEmitSingle` as a signed Creditcoin
   transaction, using the server's `CREDITCOIN_SIGNER_KEY` when provided.
   Without the key, the tool refuses with instructions rather than failing
   silently. The signer is never exposed to the agent or the browser.
4. **Verification UI**: any payment's proof can be re-checked live. The
   certificate-verifier component on the payments page accepts a pasted or
   dropped exported JSON certificate and reruns every check (schema,
   consistency, builder, on-chain, receipt) against the chain.
5. **Batch attest** (`/api/payments/attest-batch`) verifies many proofs in
   one pass.

`ATTESTCOIN_NETWORK=testnet|mainnet` switches the whole pipeline's endpoints
(`config.ts`); `developer docs/` holds the protocol reference.

### 4. Smart contracts (`contracts/`)

Solidity sources, compiled in-process by the app's own solc service
(`lib/contracts/compile.ts`) with no external toolchain. Compile tests
assert real bytecode:

| Contract | Role |
| --- | --- |
| `ConditionalRelease.sol` | escrow: funds released only when an Attestcoin proof verifies on-chain |
| `CrossChainSwapSource.sol` | locks ETH on Sepolia (source side of a swap) |
| `CrossChainSwapDestination.sol` | releases tCTC on Creditcoin, proof-gated, with refund path |
| `templates/` | vetted deployables (ERC-20, escrow, multisig) the agent can deploy after the confirmation card |
| `vendor/` | Attestcoin verification interfaces |

Amount integrity rule, enforced in both executors and contracts: the lock
side and release side of a swap are separate values, converted only through
the fixed on-chain rate. A single number is never reused across chains.

### 5. Data layer (`src/db/`)

drizzle-orm over better-sqlite3. The database file is created and migrated
at runtime by `ensureDb()` in `src/db/index.ts` using idempotent DDL, so
`bun run db:push` is a no-op by design. Default path `./sqlite.db`,
overridable with `ACP_DB_PATH`.

Eight tables:

| Table | Contents |
| --- | --- |
| `payments` | every payment: recipient, token, amount (human + base units), status, tx hash, chain, and attestation fields (`attested_at`, `attest_root`, `onchain_verified_at`, `cc3_tx_hash`) |
| `contacts` | the address book (label ↔ address, favorite, lastUsed) that the agent resolves names against |
| `notifications` | inbox; rows reference `related_payment_id` for deep links |
| `recurring_schedules` | cadence, next/last fire, executions/max, active, last dispatch outcome |
| `agent_settings` | single `local` row: mainnet deploy opt-in, warning dismissal, active chain keys |
| `agent_actions` | the user-visible action log: every tool attempt, status machine (`pending → awaiting_confirmation → running → succeeded/failed/declined/interrupted`), risk class, USD value, proof refs |
| `skills` | skill library (instructions, tool allowlist JSON, enabled) |
| `automation_rules` | trigger/condition/action rules the automation poller evaluates |

Amounts are stored both as human-readable strings and as base-unit strings;
transactions use the base-unit string, so there is no float drift.

### 6. API surface (`src/app/api/**`, 27 routes)

| Prefix | Routes | Notes |
| --- | --- | --- |
| `agent/` | `run`, `respond`, `actions`, `policy`, `test-connection` | the NDJSON pair, the action log, and policy |
| `attestcoin/` | `status`, `recent`, `proof`, `verify-certificate` | network status, recent attestations, proof fetch, live certificate verification |
| `payments/` | route, `[id]`, `attest-batch` | history, per-payment ops, batch attest |
| `contacts/` | route, `[id]`, `used` | CRUD plus lastUsed bump |
| `recurring/` | route, `[id]` | schedule CRUD (hard deletes: rows are removed, not soft-hidden) |
| `automation/` | route, `[id]` | rule CRUD |
| `skills/` | route, `[id]` | skill CRUD (registry-validated allowlists) |
| `wallet/` | `activity` | on-chain activity log join |
| `models/` | route | model listing for the provider form |
| `notifications/` | route, `[id]`, `mark-all-read`, `unread-count` | inbox plus the badge feed (count only) |

All routes use the Node runtime (better-sqlite3 is native). The agent's
model calls proxy the browser-supplied key per run; nothing secret is
persisted server-side.

### 7. Frontend architecture

#### 7.1 Rendering model

The entire app frame renders client-side. `layout.tsx` mounts `Web3Provider`
(wagmi requires `window`), and every page is a client component behind it.
`cacheComponents` is off (the rationale is recorded in `next.config.ts`).
Heavy surfaces (chat, wallet, recurring) are `next/dynamic` chunks with
skeletons.

#### 7.2 Chat surface

`src/components/chat-view.tsx` composes:

- **Transcript**: messages with streaming text, collapsible thinking blocks,
  and rendered tool-call traces (`agent-trace.tsx`) showing each step's
  status and details.
- **Intent cards** (`intent-card.tsx`): structured previews of what the agent
  is about to do (transfer, deploy, swap), including the pre-deployment
  confirmation card with source and a plain-English summary.
- **Composer** (`chat-input.tsx`): `@contact` mentions (resolved against the
  address book) and `/` slash-commands.
- **Sessions sidebar**: chat list with pin/rename/delete, plus full-text
  search over messages, reasoning, and traces.

#### 7.3 Navigation and shell

`app-shell.tsx` and `navbar.tsx` implement a responsive frame, tested at
desktop (1280+) and Android width (390):

- **Android (<sm)**: top bar with logo and chats toggle; navigation lives in
  the bottom tab bar. "More" opens a drawer that ends above the tab bar so
  its toggle stays reachable.
- **Tablet (sm–xl)**: centered capsule with a hamburger behind the logo.
- **Desktop (xl+)**: centered capsule with links (icon-only at xl, labeled
  at 2xl), plus a separate top-right chain+wallet capsule.

The brand mark is theme-aware with zero JavaScript: two `<img>` elements,
one `.dark:hidden`, one `.hidden .dark:block` (§7.5).

#### 7.4 State management

- **Zustand** for UI state: mobile-nav drawer, chats sidebar, palette
  events, install banner, theme/font preference persistence.
- **TanStack Query** for all API data, with shared query keys so surfaces
  never disagree. For example, `["contacts"]` is used by the mentions
  resolver, the contacts page, and the wallet activity "pay again" label
  resolver; the settled-totals reducer is one function reused by contacts
  and payments.
- **Local storage** for the AI provider config (endpoint, API key, model;
  the key stays in the browser), draft messages, language, and theme.

#### 7.5 Theming and brand

A `dark` class on `<html>`, switched by a lightweight `use-theme.ts`,
selectable from the navbar, persisted in local storage, with no SSR flash.
The logo system (`brand.tsx`) renders the dark and light wordmark PNGs as a
height-driven `<img>` pair, correct in both themes with zero client
JavaScript.

#### 7.6 i18n

Four dictionaries in `src/lib/i18n/`. `TranslationKey` is derived from
`en.ts` (`keyof` the en dictionary); the other three locales annotate
`Record<TranslationKey, string>`, so a missing or extra translation key is a
compile error, not a runtime failure. A parity test additionally sweeps all
four files at test time. ~1,090 keys, fully translated.

### 8. Build and operations

- **Dev**: `bun run dev` runs `next dev --turbopack -p 3000`. Memory is
  bounded with `MALLOC_ARENA_MAX=2` and `--max_old_space_size=2048`.
- **Testing**: `bun run test` runs 110 tests: agent-loop behavior,
  fund-safety invariants, contract compilation to bytecode, recurring-fire
  timing, skills seeding and versioning, the Attestcoin pipeline, and a
  tool-coverage suite asserting that every registry tool parses its sample,
  has a dispatch case, and has trace labels in all four locales.

### 9. Security model

1. **API key**: browser local storage only; proxied per run; never stored
   server-side; never available to the agent as a tool.
2. **Closed toolset**: zod-parsed and registry-enumerated; unknown names are
   rejected structurally.
3. **Fund moves**: the model supplies intent only; the browser builds the
   transaction; the wallet signature is the confirmation. The model never
   supplies raw calldata.
4. **Deployments**: always a source plus plain-English confirmation card;
   mainnet deploys additionally require the opt-in policy flag (off by
   default).
5. **Proof submission**: uses a dedicated, optional server signer key that
   the agent and browser can neither read nor choose; the tool refuses with
   instructions when unset.
6. **Action log**: every attempt is recorded with proof refs; `/payments`
   surfaces the log as the audit trail.

</details>



