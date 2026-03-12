---
sidebar_position: 2
title: Cryptographic Guarantees
---

# Cryptographic Guarantees

This page describes the security properties that Verbeth proves cryptographically: forward secrecy, post-compromise security, and post-quantum resistance. For implementation details, see [Double Ratchet](../ratchet/double-ratchet.md) and [Protocol Flow](../../how-it-works/protocol-flow.md).

## Forward Secrecy

In short, this is when a compromise of current keys does not reveal past messages.

Verbeth provides forward secrecy unconditionally from message 0. The [Handshake](../handshake.md) uses only ephemeral keys — no long-term keys participate in key derivation. Both parties generate fresh X25519 keypairs and a fresh ML-KEM keypair for each handshake, and delete the private halves immediately after deriving the shared secret. Because no long-term secret is mixed into the key exchange, even full compromise of a party's identity keys cannot recover past session keys.

After the handshake, the [Double Ratchet](../ratchet/double-ratchet.md) continues this guarantee: each ratchet step derives new keys from a fresh DH exchange, and old chain keys are deleted after use. Forward secrecy holds as long as old keys are actually deleted — application developers must ensure session state is not backed up in ways that preserve spent keys.

## Post-Compromise Security

This is when after a state compromise, security is eventually restored without manual intervention.

### Against Classical Adversary

We achieve full PCS. When the next DH ratchet step occurs, both parties contribute fresh randomness to a new Diffie-Hellman exchange. The resulting shared secret is unknown to the attacker who only has the old state, so all subsequent keys are secure:

```
Compromise at epoch i
        |
[RK_i known] [msg_i] [msg_{i+1}] [ next DH ratchet: dh_{i+1} ] [future messages]
     x          x         x                 unknown to attacker       ok
                                              |
                                              '-- cannot compute RK_{i+1}
                                                  security restored
```

The attacker can read messages until the next DH exchange. After that, they are locked out. The speed of recovery depends on how quickly both parties send messages (each direction change triggers a DH ratchet).

### Against Quantum Adversary

If an adversary has both a quantum computer and a snapshot of device state, PCS is degraded because subsequent DH ratchet steps use X25519. Security is not restored until a new PQ key exchange occurs which the current ratchet does not perform.

This is an honest limitation shared by all major double-ratchet protocols today. Full PQ PCS would require hybrid KEM ratcheting.

## Post-Quantum Security

### HNDL Resistance

"Harvest Now, Decrypt Later" is the most practical near-term quantum threat. Verbeth mitigates it end-to-end because:

1. ML-KEM-768 protects the initial key exchange
2. The root key gets derived from hybrid secret
3. All chain keys descend from the PQ-secure root via KDF. So, every message in the session is HNDL-resistant.

For how PQ security compares across protocols, see [here](../handshake.md#other-pq-secure-handshake-protocols).


### Limitations recap

- After the hybrid handshake, ongoing ratchet re-keying uses X25519 only. So Verbeth stays HNDL-resistant against passive recording, because later keys still descend from the original PQ-secure root key. But it does not provide full post-quantum PCS after a live state compromise, since recovery would rely on new X25519 ratchet steps rather than a fresh PQ exchange.  
- The same caveat applies to topic ratcheting. New topics are derived from classical DH output, with the PQ-secure root key only used as salt, so they do not gain fresh post-quantum security at each ratchet step.