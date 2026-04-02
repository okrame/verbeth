---
sidebar_position: 6
title: Wire Formats
---

# Wire Formats

This page catalogs every binary layout, serialization format, and encoding convention used in the SDK. 

## Ratchet message payload

Every post-handshake message is a single binary blob emitted as an Ethereum event. The signature comes first so recipients can verify authenticity before touching any ratchet state. See `ratchet/codec.ts`.

```
Offset  Size     Field
──────────────────────────────────────────────────
0       1        Version (0x01)
1       64       Ed25519 signature (detached)
65      32       DH ratchet public key
97      4        pn (uint32, big-endian)
101     4        n  (uint32, big-endian)
105     24       XSalsa20-Poly1305 nonce
129     var      XSalsa20-Poly1305 ciphertext
──────────────────────────────────────────────────
Minimum total: 129 + ciphertext bytes
```

The signature covers bytes 65 through the end (header + nonce + ciphertext). Verification is `Ed25519.verify(signature, payload[65..], senderSigningPublicKey)`.

`pn` is the number of messages sent in the previous DH epoch (used by the receiver to pre-derive skipped keys). `n` is the message number in the current epoch.

## Unified public key format

Long-term public keys are encoded as a versioned 65-byte blob. Used in the `pubKeys` field of the `Handshake` event. See `payload.ts`.

```
Byte 0        Bytes 1..32       Bytes 33..64
┌────────┬──────────────────┬──────────────────┐
│  0x01  │  X25519 (32 B)   │  Ed25519 (32 B)  │
└────────┴──────────────────┴──────────────────┘
```

## Extended ephemeral key format

The `ephemeralPubKey` field in the `Handshake` event concatenates the X25519 ephemeral key with the ML-KEM-768 public key. See `handshake.ts`.

```
Bytes 0..31          Bytes 32..1215
┌────────────────┬─────────────────────────┐
│ X25519 (32 B)  │ ML-KEM-768 pk (1184 B)  │
└────────────────┴─────────────────────────┘
Total: 1216 bytes
```

The responder splits on offset 32 to extract both keys.

## Handshake plaintext payload

The `plaintextPayload` field in the `Handshake` event is a UTF-8 encoded JSON string. It is not encrypted because the identity proof is intended to be publicly verifiable. See `payload.ts`.

```json
{
  "plaintextPayload": "Hello, want to chat?",
  "identityProof": {
    "message": "VerbEth Key Binding v1\nAddress: 0x...\n...",
    "signature": "0x..."
  }
}
```

## Handshake response encrypted payload

The `ciphertext` field in the `HandshakeResponse` event is a UTF-8 encoded JSON envelope wrapping a NaCl box. The box is encrypted with X25519 using the ratchet keypair (not the tag keypair). See `crypto.ts` and `payload.ts`.

### Envelope format

```json
{
  "v": 1,
  "epk": "<base64 ephemeral public key>",
  "n": "<base64 nonce (24 bytes)>",
  "ct": "<base64 NaCl box ciphertext>",
  "sig": "<base64 Ed25519 signature (optional)>"
}
```

### Decrypted inner content

After `NaCl.box.open(ct, n, epk, initiatorEphemeralSecret)`, the resulting JSON contains:

```json
{
  "unifiedPubKeys": "<base64, 65 bytes>",
  "ephemeralPubKey": "<base64, 32 bytes (ratchet DH key)>",
  "kemCiphertext": "<base64, 1088 bytes (ML-KEM ciphertext)>",
  "note": "Hey, accepted!",
  "identityProof": { ... }
}
```

The `ephemeralPubKey` here is the responder's ratchet DH public key (not the tag key `R` that appears on-chain). The `kemCiphertext` is the ML-KEM-768 encapsulation that the initiator decapsulates to recover the KEM shared secret.

## Ciphertext padding

Before encryption, plaintext is framed and padded to reduce length-based metadata leakage. See `ratchet/padding.ts`.

```
┌────────┬──────────────────────┬───────────┬──────────────────┐
│ 0x00   │ plaintext length     │ plaintext │ random padding   │
│ marker │ (4 bytes, big-endian)│           │                  │
└────────┴──────────────────────┴───────────┴──────────────────┘
```

Bucket selection follows this scheme.

| Framed size | Bucket rule |
|-------------|-------------|
| ≤ 64 bytes | 64 (minimum) |
| 65 to 16,384 bytes | Next power of 2 |
| > 16,384 bytes | Next multiple of 4,096 |

On top of the bucket size, a random jitter of up to `floor(bucket / 8)` bytes is added using `nacl.randomBytes`. The padding bytes are cryptographically random and become indistinguishable from ciphertext after XSalsa20-Poly1305 encryption. The overall effect is that ciphertext sizes reveal at most O(log n) bits about plaintext length in the exponential range.

## Topic format

Topics are bytes32 values derived from HKDF output and then hashed with keccak256. See `ratchet/kdf.ts`.

```
okm    = HKDF-SHA256(ikm=dhOutput, salt=rootKey, info="verbeth:topic-{direction}:v3", len=32)
topic  = keccak256(okm)
```

## Recipient hash

The `recipientHash` field in the `Handshake` event identifies the intended recipient without revealing their address directly. See `handshake.ts`.

```
recipientHash = keccak256(utf8("contact:" + lowercase(recipientAddress)))
```

## Identity proof binding message

The structure is defined in [Identity](../concepts/identity.md). For wire format reference, the message is a newline-delimited plaintext string.

```
VerbEth Key Binding v1
Address: 0xabc...
PkEd25519: 0x123...
PkX25519: 0x456...
ExecutorAddress: 0xdef...
ChainId: 8453
RpId: my-app
```

This message is ECDSA-signed by the wallet and included in the `identityProof` field of both handshake and handshake response payloads.
