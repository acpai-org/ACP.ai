---
url: "https://docs.attestcoin.org/attestcoin-protocol/attestcoin-writability"
title: "Attestcoin Writability | Attestcoin"
---

For the complete documentation index, see [llms.txt](https://docs.attestcoin.org/llms.txt). This page is also available as [Markdown](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-writability.md).

Attestcoin Protocol Writability allows Creditcoin users and contracts to send messages to any destination chain. These messages contain an arbitrary payload of data and trigger actions in the receiving contract. Writability has four simple steps:

1. **Message publishing -** A user or contract publishes a message to the outbox for their desired destination chain. Payment for delivery is submitted separately to a relayer contract.

2. **Message signing -** Attestors listen for new messages, wait for block finality per message on Creditcoin, then sign each message. The message is considered signed once a quorum of signatures (⅔ + 1) is reached.

3. **Message delivery -** Relayers listen to attestor P2P traffic and track signature counts. Once a message has a quorum of signatures, the relayer delivers both the message and its signatures to the destination chain via a call to its inbox contract.

4. **Message validation -** The inbox contract checks attestor signatures against the message it received. If the message was tampered with in any way, or if any signature doesn't correspond to a valid attestor, then this check fails. Validated message contents are then forwarded to the messages designated destination contract. There, data is unpacked and dApp specific logic is triggered.


With these four steps Creditcoin contracts can interact with many previously isolated chains, connecting pools of functionality and liquidity.

Writability is undergoing 3rd party testing and audits. Once the writability feature is mature and released on Creditcoin testnet, additional details will be available in sub-pages here.

[PreviousGas Costs](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability/gas-costs) [NextdApp Builder Infrastructure](https://docs.attestcoin.org/attestcoin-protocol/dapp-builder-infrastructure)

Was this helpful?