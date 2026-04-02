---
sidebar_position: 3
title: Client
---

# Verbeth Client

`VerbethClient.ts` is the high-level API that ties together handshakes, session management, message encryption, and transaction submission.

## Data model

VerbethClient holds references to an executor, an identity keypair, an identity proof, a signer, and the user's address. On top of that, it wraps two internal coordinators that connect it to the app's persistence layer.

**SessionManager** (`client/SessionManager.ts`) provides an in-memory cache over the `SessionStore` interface. It handles topic-based routing by checking inbound topics in order (current, then next, then previous) and automatically promotes `nextTopicInbound` to `currentTopicInbound` when a message arrives on it. The cache is write-through, meaning every `save()` updates both cache and store.

**PendingManager** (`client/PendingManager.ts`) tracks the lifecycle of outbound messages through two active states: `preparing` → `submitted`. On confirmation the pending record is deleted (there is no `confirmed` state). On failure there are two paths: `markFailed()` at submit time if the transaction was never broadcast, or `revertTx()` after broadcast if the on-chain transaction reverts. Both clean up the pending record. It wraps the `PendingStore` interface and handles creation, status updates, and stale record cleanup.

Both managers are optional. If only encryption and decryption are needed (without full send/confirm lifecycle), only `SessionStore` is required. `PendingStore` is needed for `sendMessage()`, `confirmTx()`, and `revertTx()`.

## Two-phase commit

Message sending follows a two-phase commit pattern to preserve forward secrecy:

1. `prepareMessage()` encrypts the plaintext, advances the ratchet chain, and immediately persists the new session state. At this point the message key is gone and cannot be recovered.

2. The transaction is submitted via the executor. If it succeeds, `confirmTx()` cleans up the pending record. If it fails, `revertTx()` does the same cleanup, but the ratchet slot is already burned. The receiver handles the resulting gap through the skip key mechanism described [here](./ratcheting.md).

This design means session state is always ahead of on-chain reality. A crash between step 1 and step 2 is safe because the pending record survives in the store, and the receiver's skip keys handle the missing message number.

## Signer path vs execution path

The client separates the **signer** as the entity that authorizes the transaction (signs it or holds the session key) from the **executor** as the mechanism that delivers the transaction to the VerbethV1 contract. The `IExecutor` interface (`executor.ts`) defines three methods: `sendMessage`, `initiateHandshake`, and `respondToHandshake`.

| Signer | Executor | When to use |
|--------|----------|-------------|
| EOA wallet (ethers `Signer`) | `EOAExecutor` | Direct wallet transaction. Simplest path. |
| `SafeSessionSigner` | `EOAExecutor` | Safe module with session key. Preferred for UX and gas cost. |
| `wallet_sendCalls` provider | `BaseSmartAccountExecutor` | Base smart accounts with optional paymaster (EIP-5792). |
| AA bundler client | `UserOpExecutor` | ERC-4337 bundler path. |

`DirectEntryPointExecutor` also exists but is meant only for local Anvil testing.

## Safe path

`SafeSessionSigner` (`utils/safeSessionSigner.ts`) is a Signer adapter, not an executor. It extends the ethers `AbstractSigner` and routes all transactions through a `SessionModule` enabled on a Safe. The execution itself still goes through `EOAExecutor` with a contract instance connected to the `SafeSessionSigner`.

The session key used here is derived during identity setup from the same wallet signature seed that produces the X25519 and Ed25519 keys (the secp256k1 branch in the key derivation hierarchy described [here](../concepts/identity.md)).

Two support contracts enable this path:

**SessionModule** (`contracts/SessionModule.sol`) is a singleton that authorizes session signers to call specific target contracts on behalf of any Safe that has enabled it. It manages per-signer expiry and per-target allowlisting. The `execute()` function checks both before forwarding the call through `ISafe.execTransactionFromModule()`.

**ModuleSetupHelper** (`contracts/ModuleSetupHelper.sol`) is a deployment helper called via `delegatecall` during `Safe.setup()`. It enables the SessionModule and configures the session in a single transaction through `enableModuleWithSession()`. Without it, enabling the module and authorizing the session signer would require two separate Safe owner transactions.

>The Safe path avoids the overhead of bundlers and paymasters entirely, because the session signer submits a normal EOA transaction that the Safe module forwards. The gas cost is comparable to a direct EOA call plus a fixed module overhead.

## AA and smart account path

`BaseSmartAccountExecutor` and `UserOpExecutor` are two transports for using a smart account to send transactions on behalf of the user.

`BaseSmartAccountExecutor` uses `wallet_sendCalls` (EIP-5792) and supports an optional paymaster service URL for gas sponsorship. It is designed primarily for Base smart accounts via Coinbase Smart Wallet or similar providers.

`UserOpExecutor` wraps the full ERC-4337 flow: building a `PackedUserOperation`, signing it through a smart account client, and sending it to a bundler. The gas overhead from UserOp validation, bundler fees, and the EntryPoint contract makes this path significantly more expensive per message than the EOA or Safe paths. For a messaging protocol where users might send hundreds of messages per day, this cost difference compounds. EIP-7702 may eventually provide a lighter alternative by allowing EOAs to adopt smart account behavior without the bundler infrastructure.

## Computational overhead

Most client operations are fast. The bottleneck `HandshakeResponse` matching, which scales linearly with the number of pending contacts which is argubly going to be relatively low.

### O(1) operations

| Operation | Time |
|-----------|------|
| Handshake lookup (by recipientHash) | ~0.01 ms |
| Message topic recomputation | ~0.02 ms |
| DH ratchet step with topic update | ~1.85 ms |

### O(P) operations

Matching a `HandshakeResponse` event to its initiating handshake requires iterating through all pending contacts (see `client/hsrMatcher.ts`). For each candidate, the matcher attempts a NaCl box decryption, an ML-KEM decapsulation, and an HKDF response tag computation. It stops on the first match.

| Pending contacts (P) | Time |
|-----------------------|------|
| 10 | ~7.7 ms |
| 50 | ~32.7 ms |
| 100 | ~61.0 ms |

These measurements are from a TypeScript benchmark on a modern laptop. In practice, P stays small for most users because pending contacts are cleared once responses arrive.
