---
sidebar_position: 2
title: Identity
---

# Identity

Verbeth binds cryptographic messaging keys to Ethereum addresses through deterministic derivation and signed proofs.

## Key Derivation

A single wallet signature produces all identity keys:

```
┌──────────────────────────────────────────────┐
│  Seed Message:                               │
│    "VerbEth Identity Seed v1"                │
│    "Address: 0x..."                          │
│    "Context: verbeth"                        │
└──────────────────────────────────────────────┘
                    ↓
              Wallet Signature
                    ↓
┌──────────────────────────────────────────────┐
│  IKM = HKDF(                                 │
│    canonicalize(sig) || H(message) ||        │
│    "verbeth/addr:" || address                │
│  )                                           │
└──────────────────────────────────────────────┘
                    ↓
          ┌────────┴────────┐────────┐
          ↓                 ↓        ↓
     X25519 key       Ed25519 key   secp256k1
    (encryption)       (signing)   session key
```

The derivation is:

1. **Deterministic**: Same signature always produces same keys
2. **Reproducible**: User can regenerate keys by re-signing
3. **Isolated**: Different addresses produce unrelated keys

### HKDF Chain

```typescript
// Intermediate Key Material
const ikm = hkdf(sha256,
  concat([canonicalSig, sha256(seedMessage), "verbeth/addr:" + address]),
  "verbeth/seed-sig-v1",
  "verbeth/ikm",
  32
);

// Derive individual keys
const x25519_sk = hkdf(sha256, ikm, "", "verbeth-x25519-v1", 32);
const ed25519_seed = hkdf(sha256, ikm, "", "verbeth-ed25519-v1", 32);
const session_sk = hkdf(sha256, ikm, "", "verbeth-session-secp256k1-v1", 32);
```

## Binding Proofs

A binding proof cryptographically ties derived keys to an Ethereum address:

```
VerbEth Key Binding v1
Address: 0xabc...
PkEd25519: 0x123...
PkX25519: 0x456...
ExecutorSafeAddress: 0xdef...
ChainId: 8453
```

This message is signed by the wallet, creating proof that:

1. The signer controls the Ethereum address
2. The signer authorizes these specific public keys
3. The proof is bound to a specific chain and executor

### Message Structure

| Field | Purpose |
|-------|---------|
| `Address` | Signer's Ethereum address |
| `PkEd25519` | Ed25519 signing public key |
| `PkX25519` | X25519 encryption public key |
| `ExecutorSafeAddress` | Safe address that will send transactions |
| `ChainId` | Chain ID for replay protection |

## Verification Standards

Verbeth supports three verification methods:

### EOA (Externally Owned Account)

Standard `ecrecover` verifies the signature against the address.

### ERC-1271 (Deployed Smart Accounts)

For deployed Safe accounts or other smart wallets:

```solidity
function isValidSignature(bytes32 hash, bytes signature)
  external view returns (bytes4);
```

The contract returns `0x1626ba7e` if the signature is valid.

### ERC-6492 (Counterfactual Accounts)

For Safe accounts that haven't been deployed yet:

```
signature = abi.encodePacked(
  factory,
  factoryCalldata,
  originalSignature
)
```

Verification simulates deployment, then calls ERC-1271.

## Safe Account Integration

When using a Safe account, the binding proof includes `ExecutorSafeAddress`:

```typescript
const { keyPair, sessionPrivateKey, sessionAddress } =
  await deriveIdentityKeys(signer, address);

const identityProof = await createBindingProof(
  signer,
  address,
  derivedKeys,
  safeAddress  // ExecutorSafeAddress field
);
```

The derived `sessionPrivateKey` creates an Ethereum wallet that can be authorized by the Safe's session module. This enables:

- Sending messages without repeated wallet signatures
- Gasless transactions via paymaster
- Programmatic messaging from backend services

## Verification Flow

When receiving a handshake or message:

```
1. Parse binding message
2. Extract claimed address and public keys
3. Verify signature:
   - EOA: ecrecover
   - Smart Account: ERC-1271
   - Counterfactual: ERC-6492
4. Compare extracted keys against message/handshake keys
5. Validate ExecutorSafeAddress matches msg.sender
6. Check ChainId matches current chain
```

If any step fails, the message is rejected.

## Security Properties

| Property | Guarantee |
|----------|-----------|
| **Key binding** | Keys are provably controlled by address owner |
| **Replay protection** | ChainId prevents cross-chain replay |
| **Executor binding** | ExecutorSafeAddress prevents unauthorized senders |
| **Determinism** | Same inputs produce same keys (recovery) |
