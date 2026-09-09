---
url: "https://docs.attestcoin.org/attestcoin-protocol.md"
title: undefined
---

> For the complete documentation index, see [llms.txt](https://docs.attestcoin.org/llms.txt). Markdown versions of documentation pages are available by appending `.md` to page URLs; this page is available as [Markdown](https://docs.attestcoin.org/attestcoin-protocol.md).

# Attestcoin Protocol

In today’s interconnected world, institutions and applications are no longer confined to a single blockchain. Value, data, and users are distributed across many networks, but connecting them securely has remained challenging.&#x20;

The most common solution has been to rely on centralized oracles and bridges, but doing so undermines the very principles that make blockchains trustworthy in the first place. By placing trust in a single oracle operator, institutions expose themselves and their clients to a single point of failure. In such a system, funds can be stolen and data can be falsified.

The diagram below illustrates how a centralized oracle concentrates power and risk in one place.

<figure><img src="/files/oMJdhGF7YNCveZREYBNz" alt=""><figcaption></figcaption></figure>

The Attestcoin Protocol acts as a cross-chain interoperability hub with its own **decentralized oracle infrastructure**. With Attestcoin, smart contracts on [`Creditcoin`](https://creditcoin.org/) gain the ability to read from, and write to, any supported chain.

Attestcoin Protocol solves the problem of cross-chain communication by eliminating the single point of failure: instead of relying on one trusted party that could corrupt or falsify data, trust is distributed across multiple independent parties, none of which can unilaterally manipulate the results. The result is institutional-grade security for third-party cross-chain apps and services.

<figure><img src="/files/fZBD4FRB08dBIM00dqyk" alt=""><figcaption></figcaption></figure>

On the Creditcoin network, apps and services use **Attestcoin Smart Contracts (ASC)**, contracts that interact with the **Attestcoin Protocol**, to execute business logic spanning any number of chains. Operating across many chains simultaneously integrates their isolated pools of information and capital, opening up new powerful business use cases.\
\
This video provides a comprehensive first look into the Attestcoin Protocol (formerly called USC):

{% file src="/files/QyqsMzGI5MYGTG1K4BVW" %}

* **Cross-chain DeFi:**
  * Automating lending, borrowing, trading, and yield farming *without intermediaries*.
  * Creating and managing cryptocurrencies, `NFT`s, and fractional ownership of real-world assets.
  * Facilitating *trustless*, automated payments and conditional fund transfers.
* **Gaming and Metaverse:**
  * Powering in-game economies, item ownership, and where appropriate, the gamification of real world interactions.
  * This is a powerful tool to influence community conscious decision making via incentivisation and fun!
* **Voting and Governance:**
  * Allowing communities to easily establish and interact with novel democratic systems.
  * Contracts can leverage digital identity and the public, immutable ledgers of blockchains to make these systems more secure and truthful than ever before.

All of these uses for blockchain become more powerful when data and liquidity across many chains are usable in one place

## **Current Attestcoin Protocol Oracle Capacity**

* Verification completes in one block (\~15 seconds): Once a source chain (EX: Ethereum) block is finalized and attested on Creditcoin, the Attestcoin Protocol's block prover precompile can validate transactions from that block synchronously. Within the span of a single Creditcoin block, a foreign transaction can be validated, decoded, and used in dApp contract execution.
* Batch query verification supports up to 10 queries which share a continuity proof.
