---
sidebar_position: 4
title: Contract
---

# Smart Contract

This page covers the main on-chain component of the protocol, that is one single transport contract.

## VerbethV1

VerbethV1 (`contracts/VerbethV1.sol`) is a UUPS-upgradeable implementation contract built on OpenZeppelin (deployed behind a separate ERC1967Proxy). This contract exists only to emit events. There is no message storage, no access control on messaging functions, no user registry, and no state beyond upgrade governance. All cryptographic validation happens client-side.

### Messaging functions

Three functions, each a thin wrapper around an event emission.

**`sendMessage(bytes ciphertext, bytes32 topic, uint256 timestamp, uint256 nonce)`** emits a `MessageSent` event indexed by `sender` and `topic`. Clients filter for their active inbound topics to find messages addressed to them.

**`initiateHandshake(bytes32 recipientHash, bytes pubKeys, bytes ephemeralPubKey, bytes plaintextPayload)`** emits a `Handshake` event indexed by `recipientHash` and `sender`. Recipients filter by `keccak256("contact:" + their_lowercase_address)` to discover handshakes directed at them.

**`respondToHandshake(bytes32 inResponseTo, bytes32 responderEphemeralR, bytes ciphertext)`** emits a `HandshakeResponse` event indexed by `inResponseTo` and `responder`. The initiator matches this to their pending handshake by recomputing the hybrid tag from their stored ephemeral secrets.

### Event indexing strategy

Each event uses two `indexed` parameters, which translates to two EVM log topics available for `eth_getLogs` filtering.

`MessageSent` indexes `sender` and `topic`. The `topic` parameter is the conversation topic derived from the ratchet (not the Solidity event topic). This allows clients to subscribe to exactly the topics they care about.

`Handshake` indexes `recipientHash` and `sender`. The recipient hash is a one-way derivation from the recipient's address, so observers cannot reverse it to learn who the handshake targets, though they can confirm a guess.

`HandshakeResponse` indexes `inResponseTo` (the hybrid tag) and `responder`. The tag is derived from shared secrets and is unlinkable to the original `Handshake` event without private key material. See [Protocol Flow](./protocol-flow.md) for the tag computation.

### Upgrade governance

The contract uses a 2-day timelock for upgrades (`UPGRADE_DELAY = 2 days`). The owner calls `proposeUpgrade(newImplementation)`, which records the target address and the earliest eligible timestamp. After the delay, the standard UUPS `upgradeToAndCall` path checks that the proposed address matches and the timelock has expired. The owner can cancel a pending upgrade at any time via `cancelUpgrade()`.

A 48-slot storage gap (`__gap`) reserves space for future state variables without disrupting the storage layout of derived contracts.

### Design philosophy

The contract deliberately does not validate messages, enforce rate limits, maintain access lists, or store any user data. There are no admin functions that can censor individual users or filter specific topics. The only privileged operation is the upgrade mechanism, which is timelocked and transparent.

>A planned [extension](../roadmap/metadata-privacy-psi.md)  will add an on-chain registry to VerbethV1, allowing users to publish ML-KEM-768 public keys so that first-message payloads can be hybrid-encrypted before any handshake response. The registry would be a simple `address → bytes` mapping with a `setContactKemKey()` setter and a free `getContactKemKey()` view function. 

## Safe support contracts

These contracts are not part of the core transport. They enable the Safe session key path where a derived secp256k1 key can send messages on behalf of a Safe without requiring the Safe owner to sign every transaction.


## Gas considerations

Gas costs on VerbethV1 are dominated by calldata. The contract logic is trivial, so almost all gas goes toward the intrinsic cost of submitting bytes to the chain.

| Operation | Gas | Dominant cost factor |
|-----------|-----|---------------------|
| Request handshake | ~85,790 | ML-KEM-768 public key (1,184 bytes in calldata) |
| Respond to handshake | ~129,110 | Encrypted payload containing KEM ciphertext (1,088 bytes inside blob) |
| Smallest msg (145 byte blob) | ~29,700 | Base event emission with minimal calldata |
| Large msg (1,450 byte blob) | ~81,850 | Calldata scaling |

>On L2s like Base, the gas numbers above reflect execution cost, but the USD cost of a transaction depends heavily on L1 conditions at the time.

### Block capacity

As of early 2026, Base L2 blocks have a gas limit of 375M (up from the original 30M target, and well above Ethereum L1's recent increase to 60M). Given that limit:

| Operation | Approx. per block |
|-----------|-------------------|
| Handshake initiation (~86k gas) | ~4,360 |
| Handshake response (~129k gas) | ~2,900 |
| Small message (~30k gas) | ~12,500 |
| Large message (~82k gas) | ~4,570 |

These are theoretical maximums assuming the entire block is Verbeth transactions, which never happens. In practice, shared blockspace and variable L1 costs mean significantly fewer operations per block. That said, continued gas limit increases are favorable for Verbeth's scalability.

### Message size and gas

The ciphertext padding scheme (described [here](./wire-formats.md#ciphertext-padding)) means even a single-byte message is padded to the 64-byte minimum bucket, resulting in a minimum payload of ~145 bytes (padded plaintext + 105-byte binary header: version, signature, DH key, counters, nonce). Longer messages grow proportionally through larger padding buckets. Since calldata dominates the gas cost, message size directly affects the per-message cost.
