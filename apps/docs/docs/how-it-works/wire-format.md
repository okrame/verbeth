---
sidebar_position: 1
title: Wire Format (wip)
---

# Wire Format (PAGE WIP...)

This page describes how ratchet messages are packed into bytes for on-chain submission, and how recipients process them.

## Binary Layout

Every ratchet message is a single binary blob emitted as an Ethereum event:

```
Offset  Size   Field
──────────────────────────────────────────
0       1      Version (0x01)
1       64     Ed25519 signature (detached)
65      32     DH ratchet public key
97      4      pn (uint32 big-endian)
101     4      n (uint32 big-endian)
105     var    Ciphertext (24-byte nonce + XSalsa20-Poly1305 output)
──────────────────────────────────────────
Minimum total: 105 + ciphertext bytes
```

The **signature comes first** by design. This lets recipients verify authenticity before touching any ratchet state — a cheap check that provides DoS protection.

## Receive & Verify

When a message arrives, the recipient processes it in strict order:

```
Receive event from chain
        │
        ▼
Parse binary payload
  ├─ signature  = bytes[1..65]
  ├─ header     = bytes[65..105]  (DH key, pn, n)
  └─ ciphertext = bytes[105..]
        │
        ▼
Ed25519.verify(signature, header ‖ ciphertext, sender_ed25519_pk)
        │
   ┌────┴────┐
   │         │
 FAIL      PASS
   │         │
 drop     ratchet decrypt
 message  (advance state, derive message key, decrypt)
```

If the signature is invalid, the message is silently dropped. No ratchet state is modified, no decryption is attempted. This prevents an attacker from corrupting a session by sending garbage to a known topic.

## Handshake Payloads

Handshake messages use a different format — they carry the identity proof and ephemeral keys as a JSON-serialized `HandshakeContent` in the event's `plaintextPayload` field. The handshake response is encrypted using NaCl box and includes the responder's identity proof, ratchet keys, and KEM ciphertext inside the encrypted blob.

See [Protocol Flow](./protocol-flow.md) for the full exchange flow.

---

*Last validated against SDK source: 2026-03-05*
