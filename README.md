<h1 align="center">
    Verbeth
</h1>

<p align="center">
  <i>E2EE messaging over the blockchain, using EVM logs as the only transport layer.</i>
</p>

<p align="center">
    <!-- <a href="https://www.npmjs.com/package/@verbeth/sdk">
        <img src="https://img.shields.io/npm/v/@verbeth/sdk?style=flat-square">
    </a> -->
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
- [**Dexie**](https://dexie.org/) – used for the local IndexedDB storage in the [demo app](https://verbeth-demo.vercel.app/)

---

## How it works

To start a conversation, Alice emits a `Handshake` event with her ephemeral keys and an identity proof. Bob sees it, verifies her, and replies with a `HandshakeResponse`. They combine X25519 and ML-KEM-768 secrets to derive a shared root key that's secure even against future quantum computers.

From there it's just encrypted `MessageSent` events back and forth. A Double Ratchet keeps churning keys forward so old messages stay safe even if something leaks later. Topics rotate too, making it hard for observers to link conversations across time. More info [here]().


### Deployed Addresses (base mainnet)

VerbethV1 (singleton) `0x51670aB6eDE1d1B11C654CCA53b7D42080802326`

ERC1967Proxy `0x82C9c5475D63e4C9e959280e9066aBb24973a663`


### Notes on the current model

**Discoverability**: If the sender does not yet know the recipient’s long-term public key (X25519), the sender (i.e. initiator) must emit a `Handshake` event. The recipient (i.e. reponder) replies with their keys and identity proof, after which the sender caches the verified mapping. If the key is already known (from a past `HandshakeResponse`, an on-chain announcement, or a static mapping), the handshake can be skipped.

**Identity key binding**: The message (es. “VerbEth Key Binding v1\nAddress: …\nPkEd25519: …\nPkX25519: …\nContext: …\nVersion: …”) is signed by the evm account directly binding its address to the long-term keys (i.e. preventing impersonation).

**Non-repudiation**: By default, confidentiality and integrity are guaranteed by AEAD with NaCl box. Additionally, the sender can attach a detached Ed25519 signature over using the Ed25519 key bound in the handshake. This effectively provides per-message origin authentication that is verifiable: a recipient (or any third party) can prove the message was produced by the holder of that specific Ed25519 key. Otherwise, attribution relies on context, making sender spoofing at the application layer harder to detect.                                                                                                                                                                                                                                                             |
