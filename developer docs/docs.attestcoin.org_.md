---
url: "https://docs.attestcoin.org/"
title: "Attestcoin Protocol | Attestcoin"
---

For the complete documentation index, see [llms.txt](https://docs.attestcoin.org/llms.txt). This page is also available as [Markdown](https://docs.attestcoin.org/attestcoin-protocol.md).

In today’s interconnected world, institutions and applications are no longer confined to a single blockchain. Value, data, and users are distributed across many networks, but connecting them securely has remained challenging.

The most common solution has been to rely on centralized oracles and bridges, but doing so undermines the very principles that make blockchains trustworthy in the first place. By placing trust in a single oracle operator, institutions expose themselves and their clients to a single point of failure. In such a system, funds can be stolen and data can be falsified.

The diagram below illustrates how a centralized oracle concentrates power and risk in one place.

![](https://docs.attestcoin.org/~gitbook/image?url=https%3A%2F%2Fcontent.gitbook.com%2Fcontent%2FwbWiMmiJwIjYCxeoW47K%2Fblobs%2FglcGG2ce1qbiTkTGCivj%2FCentralized-Oracle-Problem.png&width=768&dpr=3&quality=100&sign=166b42f8c388140efa235bdf0a1f6f52&sv=3)

The Attestcoin Protocol acts as a cross-chain interoperability hub with its own **decentralized oracle infrastructure**. With Attestcoin, smart contracts on [`Creditcoin`](https://creditcoin.org/) gain the ability to read from, and write to, any supported chain.

Attestcoin Protocol solves the problem of cross-chain communication by eliminating the single point of failure: instead of relying on one trusted party that could corrupt or falsify data, trust is distributed across multiple independent parties, none of which can unilaterally manipulate the results. The result is institutional-grade security for third-party cross-chain apps and services.

![](https://docs.attestcoin.org/~gitbook/image?url=https%3A%2F%2Fcontent.gitbook.com%2Fcontent%2FwbWiMmiJwIjYCxeoW47K%2Fblobs%2F02WVNXl0TzhUjOInPQDh%2FDecentralized-Oracle-Solution.png&width=768&dpr=3&quality=100&sign=e8d51cec4900447a9acd3677385a8bd6&sv=3)

On the Creditcoin network, apps and services use **Attestcoin Smart Contracts (ASC)**, contracts that interact with the **Attestcoin Protocol**, to execute business logic spanning any number of chains. Operating across many chains simultaneously integrates their isolated pools of information and capital, opening up new powerful business use cases.

This video provides a comprehensive first look into the Attestcoin Protocol (formerly called USC):

[Introduction to Creditcoin USC.mp4](https://content.gitbook.com/content/wbWiMmiJwIjYCxeoW47K/blobs/0duQ5Fb6sQPAhwMlFN4E/Introduction%20to%20Creditcoin%20USC.mp4)

20MB

Download [Open](https://content.gitbook.com/content/wbWiMmiJwIjYCxeoW47K/blobs/0duQ5Fb6sQPAhwMlFN4E/Introduction%20to%20Creditcoin%20USC.mp4)

- **Cross-chain DeFi:**



  - Automating lending, borrowing, trading, and yield farming _without intermediaries_.

  - Creating and managing cryptocurrencies, `NFT`s, and fractional ownership of real-world assets.

  - Facilitating _trustless_, automated payments and conditional fund transfers.


- **Gaming and Metaverse:**



  - Powering in-game economies, item ownership, and where appropriate, the gamification of real world interactions.

  - This is a powerful tool to influence community conscious decision making via incentivisation and fun!


- **Voting and Governance:**



  - Allowing communities to easily establish and interact with novel democratic systems.

  - Contracts can leverage digital identity and the public, immutable ledgers of blockchains to make these systems more secure and truthful than ever before.


All of these uses for blockchain become more powerful when data and liquidity across many chains are usable in one place

## **Current Attestcoin Protocol Oracle Capacity**[Direct link to heading](https://docs.attestcoin.org/\#current-attestcoin-protocol-oracle-capacity)

- Verification completes in one block (~15 seconds): Once a source chain (EX: Ethereum) block is finalized and attested on Creditcoin, the Attestcoin Protocol's block prover precompile can validate transactions from that block synchronously. Within the span of a single Creditcoin block, a foreign transaction can be validated, decoded, and used in dApp contract execution.

- Batch query verification supports up to 10 queries which share a continuity proof.


[NextArchitecture](https://docs.attestcoin.org/attestcoin-protocol/architecture)

Last updated 5 days ago

Was this helpful?