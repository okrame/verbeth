<h1 align="center">
    Verbeth
</h1>

<p align="center">
  <i>E2EE messaging over the blockchain, using EVM logs as the only transport layer.</i>
</p>

<p align="center">
    <a href="https://www.npmjs.com/package/@verbeth/sdk">
        <img src="https://img.shields.io/npm/v/@verbeth/sdk?style=flat-square">
    </a>
    <a href="LICENSE">
        <img src="https://img.shields.io/badge/license-MPL--2.0-blue?style=flat-square">
    </a>
    <a href="https://www.typescriptlang.org/">
        <img src="https://img.shields.io/badge/TypeScript-5.4+-blue?style=flat-square&logo=typescript">
    </a>
    <a href="https://github.com/okrame/verbeth/actions/workflows/ci.yml">
        <img src="https://github.com/okrame/verbeth/actions/workflows/ci.yml/badge.svg?branch=dev%2Fstealth-hsr&label=tests" />
    </a>
    <!-- <a href="https://codecov.io/gh/okrame/verbeth">
        <img src="https://img.shields.io/codecov/c/github/okrame/verbeth?style=flat-square">
    </a> -->
</p>



#### Built with

- [**Noble**](https://paulmillr.com/noble/) – audited JS implementations for curves, hashes, secp256k1, and ML-KEM-768 (post-quantum)
- [**TweetNaCl**](https://tweetnacl.js.org/) – for encryption/decryption with NaCl box
- [**Ethers v6**](https://docs.ethers.org/v6/) – for all Ethereum interactions
- [**Viem**](https://viem.sh/) – specific for EIP-1271/6492 verification



## How it works

To start a conversation, Alice emits a `Handshake` event with her ephemeral keys and an identity proof. Bob sees it, verifies her, and replies with a `HandshakeResponse`. They combine X25519 and ML-KEM-768 secrets to derive a shared root key that's secure against future quantum computers.

From there it's just encrypted `MessageSent` events back and forth. A Double Ratchet keeps churning keys forward so old messages stay safe even if something leaks later. Topics rotate too, making it hard for observers to link conversations across time.


### Deployed Address

Verbeth goes through the proxy at `0x82C9c5475D63e4C9e959280e9066aBb24973a663`. The current implementation behind it is `VerbethV1` at `0x51670aB6eDE1d1B11C654CCA53b7D42080802326`. Every deployment uses deterministic CREATE2, so the same address shows up on every supported chain:

| Chain | Chain ID |
| --- | --- |
| Base mainnet | 8453 |
| Base Sepolia | 84532 |
| Ethereum Sepolia | 11155111 |

For mor in-depth explanations on like discoverability, identity key binding and non-repudiation head over to the [docs](https://docs.verbeth.xyz).


## Install

The SDK is published on npm as [`@verbeth/sdk`](https://www.npmjs.com/package/@verbeth/sdk). Drop it into any project with

```bash
npm install @verbeth/sdk
```

or with pnpm

```bash
pnpm add @verbeth/sdk
```


## Build from source

If you want to hack on the protocol locally, clone the repo and build everything from scratch. You'll need pnpm since the workspace relies on it.

```bash
git clone https://github.com/okrame/verbeth.git
cd verbeth
pnpm install
pnpm run build
```

That compiles both the SDK and the contracts. The SDK lands in `packages/sdk/dist` with CJS and ESM outputs ready to be consumed.

To run the test suite

```bash
pnpm run test:unit         
pnpm run test:contracts     
pnpm run test:integration   
```

The integration tests need Anvil running, so run it in another terminal first with `pnpm run anvil:start`.
