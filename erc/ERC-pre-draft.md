---
title: Event-Log Encrypted Messaging
description: A minimal application-layer standard for post-quantum-resistant encrypted messaging over EVM event logs.
author: Marco (@okrame)
discussions-to:
status: Draft
type: Standards Track
category: ERC
created: 2026-04-08
---

> Note: this document is a pre-draft working paper kept in the Verbeth repository.

## Abstract

This proposal defines a minimal application-layer standard for post-quantum-resistant encrypted messaging over EVM event logs.

It standardizes:

- a transport contract interface with three functions and three events for handshake initiation, handshake response, and post-handshake message delivery;
- canonical wire formats for long-term public keys, handshake payloads, handshake response payloads, and ratcheted message payloads;
- derivation rules for recipient discovery hashes and post-handshake message topics; and
- a wallet-bound identity proof format that binds messaging keys to an Ethereum account.

The design aims to preserve message confidentiality while still supporting disclosure-time authorship and accountability: the chain proves that an account authorized publication of a ciphertext, and disclosed protocol artifacts can later bind that ciphertext to a wallet-authorized messaging identity.

The proposal does not standardize local storage, notifications, indexers, private retrieval, wallet UX, gas sponsorship, session modules, or deployment addresses.

## Motivation

Ethereum applications lack a widely documented application-layer standard for interoperable encrypted messaging based purely on onchain transport. Existing applications typically rely on proprietary relays, application-specific servers, or unpublished wire formats, which makes interoperation between independent clients difficult.

This proposal is motivated by five goals:

1. Define a minimal transport primitive that any EVM application can implement without depending on an operator-controlled message server.
2. Standardize enough of the wire format to allow independent implementations to parse, verify, and decrypt the same handshake and message flows.
3. Bind messaging keys to Ethereum accounts using wallet signatures, so recipients can authenticate long-term messaging keys before trusting them.
4. Preserve accountable privacy by combining encrypted payloads with public transport-level authorship and signed transcript artifacts that can be verified after voluntary disclosure.
5. Preserve a narrow scope suitable for standardization by excluding storage, indexing, private retrieval, and account-abstraction-specific UX choices.

This proposal is deliberately narrower than a full messaging stack. It does not attempt to standardize contact lists, inbox sync, push notifications, message history export, anti-spam systems, or application-specific presentation logic.

Unlike deniable offchain messaging systems, this proposal treats public transport-level attribution as a first-class design constraint. That tradeoff enables applications where message contents should remain private during normal operation, but participants may later need portable proof of who authorized a given encrypted exchange. Example use cases include private deal negotiation, agent-to-agent commerce, delegated service procurement, dispute resolution, and compliance-sensitive messaging where confidentiality and accountable authorship are both required.

This proposal also differs from registry-centric messaging approaches such as [ERC-7627](https://eips.ethereum.org/EIPS/eip-7627) by focusing on event-log transport and interoperable message exchange rather than requiring an onchain public-key directory as a mandatory prerequisite. A future extension MAY define optional registry mechanisms compatible with this transport.

This proposal standardizes transport interoperability, not full metadata anonymity. In particular, it distinguishes two privacy goals that are often conflated:

1. recipient privacy against public onchain observers; and
2. query privacy against malicious RPC providers or indexers.

The current design provides strong unlinkability between `HandshakeResponse` and later `MessageSent` events, but it does not fully hide attempted first contact when recipient discovery uses a deterministic `recipientHash`.

### Design goals

- Minimal onchain logic.
- Offchain cryptographic verification.
- Interoperable wire formats.
- Support for EOAs and smart accounts as transport senders.
- Compatibility with event-log retrieval via `eth_getLogs`.

### Non-goals

- Onchain message decryption or validation.
- Onchain nonce enforcement or replay prevention.
- Standardizing a specific indexer architecture.
- Standardizing private mailbox retrieval.
- Standardizing Safe modules, paymaster flows, or bundler flows.
- Standardizing contract upgrade governance.
- Standardizing deterministic deployment addresses.

## Specification

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119 and RFC 8174.

### 1. Transport contract

A compliant transport contract MUST expose the following functions:

```solidity
function sendMessage(
    bytes calldata ciphertext,
    bytes32 topic,
    uint256 timestamp,
    uint256 nonce
) external;

function initiateHandshake(
    bytes32 recipientHash,
    bytes calldata pubKeys,
    bytes calldata ephemeralPubKey,
    bytes calldata plaintextPayload
) external;

function respondToHandshake(
    bytes32 inResponseTo,
    bytes32 responderEphemeralR,
    bytes calldata ciphertext
) external;
```

A compliant transport contract MUST emit the following events:

```solidity
event MessageSent(
    address indexed sender,
    bytes ciphertext,
    uint256 timestamp,
    bytes32 indexed topic,
    uint256 nonce
);

event Handshake(
    bytes32 indexed recipientHash,
    address indexed sender,
    bytes pubKeys,
    bytes ephemeralPubKey,
    bytes plaintextPayload
);

event HandshakeResponse(
    bytes32 indexed inResponseTo,
    address indexed responder,
    bytes32 responderEphemeralR,
    bytes ciphertext
);
```

The transport contract:

- MUST set `sender` or `responder` to `msg.sender`;
- MUST NOT require recipient registration;
- MUST NOT parse or validate encrypted payload contents onchain;
- MUST NOT enforce nonce uniqueness; and
- MAY include non-messaging administrative functions, but such functions are outside the scope of this proposal.

`timestamp` and `nonce` are sender-supplied metadata. Receivers MUST treat them as application-level ordering and deduplication hints, not as globally trusted consensus facts.

### 2. Recipient discovery hash

Handshake discovery uses a recipient hash derived from the intended recipient address.

The canonical derivation is:

```text
recipientHash = keccak256(utf8("contact:" + lowercase(recipientAddress)))
```

Implementations MUST lowercase the hex address before concatenation.

The `recipientHash` is a discovery selector for efficiency, not a guarantee of recipient anonymity. Because it is deterministic, observers who can guess candidate recipient addresses can test those guesses offline.

Implementations:

- MUST treat `recipientHash` as a privacy tradeoff rather than a privacy proof;
- SHOULD assume that server-side filtering on `recipientHash` reveals recipient interest to any RPC or indexer that sees the query; and
- SHOULD prefer client-side scanning or equivalent private retrieval mechanisms when query privacy against a third-party RPC or indexer is a primary goal.

### 3. Long-term public key format

The `pubKeys` field in `Handshake` MUST encode the sender's long-term messaging public keys as a versioned 65-byte blob:

```text
Byte 0        Bytes 1..32       Bytes 33..64
0x01          X25519 public key Ed25519 public key
```

- Version `0x01` is REQUIRED for this proposal.
- The X25519 key MUST be 32 bytes.
- The Ed25519 key MUST be 32 bytes.

Implementations MAY accept legacy unversioned 64-byte formats for backwards compatibility, but compliant emitters MUST emit the 65-byte versioned format above.

### 4. Handshake payload

The `ephemeralPubKey` field in `Handshake` MUST contain:

```text
Bytes 0..31          Bytes 32..1215
X25519 ephemeral key ML-KEM-768 public key
```

Total length: `1216` bytes.

The `plaintextPayload` field in `Handshake` MUST be a UTF-8 encoded JSON object with the following shape:

```json
{
  "plaintextPayload": "string",
  "identityProof": {
    "message": "string",
    "signature": "0x..."
  }
}
```

The payload is intentionally plaintext. Implementations MUST assume its contents are publicly visible.

### 5. Wallet-bound identity proof

The `identityProof` object binds the sender's long-term messaging keys to an Ethereum account using a wallet signature.

The canonical message format is a newline-delimited UTF-8 string:

```text
VerbEth Key Binding v1
Address: 0xabc...
PkEd25519: 0x123...
PkX25519: 0x456...
ExecutorAddress: 0xdef...
ChainId: 8453
RpId: example.app
```

Rules:

- `Address` MUST be the signing Ethereum account.
- `PkEd25519` MUST equal the Ed25519 public key published in `pubKeys`.
- `PkX25519` MUST equal the X25519 public key published in `pubKeys`.
- `ExecutorAddress` MUST identify the account expected to appear as the transport sender.
- `ChainId` is OPTIONAL but RECOMMENDED.
- `RpId` is OPTIONAL but RECOMMENDED.

For direct EOA transport, `Address` and `ExecutorAddress` MAY be equal. For smart-account transport, `Address` MAY identify the signing controller while `ExecutorAddress` identifies the account that emits the transport events.

How implementations derive long-term messaging keys is out of scope. This proposal standardizes the binding proof format, not the seed derivation algorithm.

Implementations verifying identity proofs:

- MUST verify that the signature authorizes the exact binding message;
- MUST verify that the bound public keys equal the keys carried by the transport payload;
- MUST verify that `ExecutorAddress` matches the transport sender expected by the receiver's context; and
- SHOULD support smart-account verification methods in addition to EOA verification.

### 6. Handshake response tag

The `inResponseTo` field in `HandshakeResponse` MUST be derived from both:

- an X25519 shared secret computed from a dedicated response tag keypair; and
- an ML-KEM-768 shared secret derived from the initiator's ML-KEM public key.

The canonical derivation is:

```text
ecdhShared = X25519(r, A)
okm        = HKDF-SHA256(
               ikm=kemSecret,
               salt=ecdhShared,
               info="verbeth:hsr-hybrid:v1",
               len=32
             )
tag        = keccak256(okm)
```

Where:

- `A` is the initiator's X25519 ephemeral public key from `Handshake`;
- `r` is the responder's dedicated response-tag private key; and
- `kemSecret` is the ML-KEM-768 shared secret produced by encapsulation to the initiator's ML-KEM public key.

The responder MUST publish the corresponding tag public key `R` as `responderEphemeralR`.

### 7. Two-key handshake response requirement

To prevent linkability between the handshake response and the first post-handshake ratchet key, the responder MUST use two distinct X25519 keypairs:

1. a response-tag keypair `(r, R)` used only for `inResponseTo` derivation; and
2. a ratchet keypair `(rk_s, rk_p)` used only for encrypted response delivery and ratchet session bootstrapping.

The public key `R` MUST be published onchain as `responderEphemeralR`.

The public key `rk_p` MUST be carried only inside the encrypted handshake response payload.

### 8. Handshake response payload

The `ciphertext` field in `HandshakeResponse` MUST be a UTF-8 encoded JSON envelope with the following shape:

```json
{
  "v": 1,
  "epk": "<base64 ephemeral public key>",
  "n": "<base64 nonce>",
  "ct": "<base64 ciphertext>",
  "sig": "<base64 signature, optional>"
}
```

The canonical encryption method for version `1` is NaCl box (`X25519 + XSalsa20-Poly1305`).

For version `1`:

- `epk` MUST be the responder ratchet public key `rk_p`;
- `n` MUST be a 24-byte nonce;
- `ct` MUST be the NaCl box ciphertext encrypted to the initiator's X25519 ephemeral public key from the handshake; and
- `sig`, if present, is OPTIONAL and reserved for detached signatures over the envelope fields.

After decryption, the inner JSON object MUST have the following shape:

```json
{
  "unifiedPubKeys": "<base64, 65 bytes>",
  "ephemeralPubKey": "<base64, 32 bytes>",
  "kemCiphertext": "<base64, 1088 bytes>",
  "note": "string, optional",
  "identityProof": {
    "message": "string",
    "signature": "0x..."
  }
}
```

Rules:

- `unifiedPubKeys` MUST use the format defined in section 3;
- `ephemeralPubKey` MUST be the responder ratchet public key `rk_p`;
- `kemCiphertext` MUST be the ML-KEM-768 ciphertext corresponding to the shared secret used in section 6; and
- `identityProof` MUST bind the responder's long-term keys to the responder's Ethereum account.

### 9. Post-handshake message payload

Each post-handshake message carried in `MessageSent.ciphertext` MUST be encoded as a single binary blob with the following layout:

```text
Offset  Size  Field
0       1     version
1       64    Ed25519 detached signature
65      32    DH ratchet public key
97      4     pn (uint32, big-endian)
101     4     n  (uint32, big-endian)
105     24    XSalsa20-Poly1305 nonce
129     var   ciphertext
```

Version `0x01` is REQUIRED for this proposal.

The Ed25519 signature MUST cover all bytes from offset `65` to the end of the payload.

When a transcript is later disclosed, verifiers can combine this signature with the wallet-bound identity proof established during the handshake to attribute the message to the sender's bound messaging key.

The payload semantics are:

- `pn`: number of messages in the sender's previous DH epoch;
- `n`: message number in the sender's current DH epoch.

### 10. Message framing and padding

Before symmetric encryption, plaintext MUST be framed as:

```text
0x00 || uint32_be(plaintext_length) || plaintext || random_padding
```

The padded size MUST be selected using the following bucket rules:

- framed size `<= 64` bytes: bucket size `64`;
- framed size `65..16384` bytes: next power of two;
- framed size `> 16384` bytes: next multiple of `4096`.

An implementation MAY add random jitter up to `floor(bucket / 8)` bytes before symmetric encryption.

### 11. Topic derivation

Post-handshake message transport uses topic hashes derived from ratchet state.

The canonical topic derivation is:

```text
okm   = HKDF-SHA256(
          ikm=dhOutput,
          salt=rootKey,
          info="verbeth:topic-{direction}:v3",
          len=32
        )
topic = keccak256(okm)
```

Where:

- `direction` is either `outbound` or `inbound`;
- `rootKey` is the current ratchet root key; and
- `dhOutput` is the X25519 DH output for the relevant ratchet step.

The root key used as HKDF salt SHOULD incorporate both classical and post-quantum shared secrets.

For the hybrid session bootstrap used by this proposal, the canonical initial root key is:

```text
combined   = x25519Secret || kemSecret
rootKey    = HKDF-SHA256(
               ikm=combined,
               salt=zeros(32),
               info="VerbethHybrid",
               len=32
             )
```

### 12. Session behavior

This proposal standardizes the transport and wire formats needed for interoperable session establishment and message exchange. It does not fully standardize application storage behavior, but the following receiver behavior is RECOMMENDED:

- receivers SHOULD track at least current, next, and previous inbound topics during topic transitions;
- receivers SHOULD support skipped-message handling for out-of-order delivery; and
- senders SHOULD treat ratchet state as committed before transaction broadcast, so failed broadcasts consume a ratchet slot rather than reusing it.

## Rationale

### Why event logs

Event logs provide the narrowest onchain primitive needed for interoperable message publication and retrieval. This keeps contract logic simple, allows independent clients to discover messages via standard RPC methods, and avoids entangling the standard with operator-run relay infrastructure.

### Why no onchain validation

The transport contract intentionally does not validate ciphertexts, public keys, signatures, or nonce sequencing. Those checks are performed offchain by clients. This lowers gas costs and preserves flexibility for implementations.

### Why plaintext handshake payloads

The handshake payload is plaintext so that the recipient can verify the wallet-bound identity proof immediately upon discovery. The tradeoff is that the handshake note is public, so applications that need a private first-contact message should use a future extension or an optional pre-key mechanism.

### Why wallet-bound identity and non-repudiation matter

Event-log transport already gives public evidence that some account authorized publication of a ciphertext at a particular block and transaction. This proposal embraces that property instead of trying to emulate deniable transport semantics that do not fit well with public logs.

The wallet-bound identity proof standardizes how long-term messaging keys are bound to an Ethereum account, while the signed ratcheted payload standardizes how later disclosed transcript material can be attributed to that bound messaging identity. Together, these pieces provide accountable privacy: message contents remain encrypted by default, but participants can later reveal specific plaintexts and protocol artifacts to prove authorship, timing, and transport publication to a third party.

This property enables use cases that benefit from both confidentiality and portable accountability. One example is an agentic economy in which autonomous agents negotiate terms, quotes, or side agreements privately, yet their operators may later need to prove which account authorized a disputed instruction or accepted a private deal. Similar requirements appear in escrow coordination, B2B operations, delegated execution, and compliance workflows.

This is intentionally different from deniable protocols in the Signal family, where transcript artifacts are designed not to become portable third-party proof. Here, the goal is not deniability; it is private communication with optional, disclosure-dependent authorship.

### Why deterministic recipient discovery remains in v1

This proposal retains a deterministic `recipientHash` because it offers a simple and easily implementable discovery primitive for first contact without requiring an onchain key registry or specialized discovery infrastructure.

The tradeoff is explicit: a deterministic recipient selector leaks attempted first-contact edges to public observers whenever the recipient is guessable from a candidate set. This proposal therefore standardizes a minimal interoperable transport, not a complete anonymous-discovery system.

A future extension MAY define an anonymous handshake-discovery profile in which recipient-targeting information is carried only inside encrypted payload material rather than exposed as a deterministic public selector.

### Why two response keypairs

Using a dedicated response-tag keypair and a separate ratchet keypair prevents an observer from linking the `HandshakeResponse` event to the first ratcheted message header.

### Why standardized wire formats

Without fixed binary and JSON layouts, independent clients may all be "Verbeth-compatible" in principle while still failing to parse each other's messages in practice. The wire format is therefore a core interoperability surface and belongs in the standard.

### Why this proposal is narrow

This proposal leaves storage, indexers, sync, UX, anti-spam systems, delegated execution modules, and deployment conventions out of scope because those concerns are either environment-specific or still evolving. The goal is to standardize the smallest stable surface first.

## Backwards Compatibility

This is a new application-layer standard and introduces no backwards compatibility issues for existing ERCs.

For local backwards compatibility with earlier Verbeth experiments:

- implementations MAY accept unversioned 64-byte long-term public key blobs;
- implementations MAY support alternative internal storage layouts; and
- implementations MAY expose additional non-standard helper methods.

However, compliant emitters MUST emit the versioned wire formats defined in this document.

## Test Cases

The following conformance scenarios SHOULD be covered by reference tests and test vectors:

1. Handshake initiation with valid `recipientHash`, `pubKeys`, `ephemeralPubKey`, and `plaintextPayload`.
2. Handshake payload rejection when `identityProof` is missing or malformed.
3. Identity proof verification failure on mismatched X25519 key, Ed25519 key, `ExecutorAddress`, `ChainId`, or `RpId`.
4. Handshake response matching via `inResponseTo` recomputation from the initiator secret material.
5. Handshake response decryption and extraction of responder long-term keys, ratchet public key, and `kemCiphertext`.
6. Initiator and responder deriving the same hybrid initial root key.
7. Post-handshake message signature verification using Ed25519 over the canonical payload bytes.
8. Topic derivation producing identical `bytes32` outputs across independent implementations.
9. Out-of-order message handling via skipped keys and previous-topic grace behavior.
10. Smart-account and EOA transport senders both interoperating with the same wire format.
11. Disclosed transcript verification combining onchain event inclusion, wallet-bound identity proof validation, and ratcheted payload signature verification.

Current reference tests in this repository include:

- `packages/sdk/test/verify.test.ts`
- `packages/sdk/test/ratchet.test.ts`
- `packages/sdk/test/codec.test.ts`
- `packages/sdk/test/pq.test.ts`
- `tests/handshaking.test.ts`
- `tests/e2e.test.ts`

## Reference Implementation

The current reference implementation is Verbeth:

- transport contract: `packages/contracts/contracts/VerbethV1.sol`
- SDK and wire-format logic: `packages/sdk/src`
- end-to-end integration tests: `tests`

This pre-draft should be accompanied by public test vectors before submission to `ethereum/ERCs`.

## Security Considerations

### Metadata goals

This proposal distinguishes between:

- privacy against a public onchain observer that sees events but not client queries; and
- privacy against a malicious RPC provider or indexer that sees both onchain events and recipient query filters.

The current design provides stronger protection for conversation continuity than for first-contact discovery.

### Public observer metadata

All onchain observers can see sender addresses, event timing, gas usage, topic hashes, and ciphertext sizes. This proposal protects message contents, not all metadata.

### Recipient discovery leakage

Because `recipientHash` is derived deterministically from the recipient address, a public observer who can guess candidate addresses can test those guesses offline.

This means the current design does not provide full recipient anonymity at handshake time. A public observer may learn that sender `A` attempted first contact with recipient `B` when `B` is guessable from the observer's candidate set.

### Continuity protection after first contact

Even when a public observer can recover the recipient from `recipientHash`, the observer still cannot use public data alone to:

- cryptographically link a `Handshake` to a later `HandshakeResponse`;
- cryptographically prove that the recipient accepted the handshake; or
- cryptographically link the handshake to later ratcheted `MessageSent` topics.

So the current design may leak attempted first contact while still protecting the stronger continuity property that later responses and post-handshake message flows are not publicly linkable by a direct cryptographic test.

### RPC and indexer query privacy

Clients querying a third-party RPC or indexer for `recipientHash`-specific handshake filters may reveal recipient interest directly to that service. This creates a bootstrap deanonymization risk: once an RPC or indexer can associate a network client with a recipient address during handshake discovery, later topic queries may become attributable to that same recipient even if the topics themselves are unlinkable onchain.

Private retrieval mechanisms are explicitly out of scope for this proposal. Implementations that rely on third-party RPCs SHOULD treat server-side recipient filtering as a privacy-sensitive operation. Implementations concerned with this threat SHOULD prefer client-side scanning or other private retrieval techniques.

### Residual traffic analysis

Even if query privacy is improved and deterministic recipient discovery is removed in a future extension, visible sender addresses, event timing, activity bursts, and traffic sparsity still create heuristic linkage opportunities.

So the intended privacy statement of this proposal is not that observers learn nothing, but that they lack a public cryptographic test for exact linkage and are forced to fall back to statistical traffic analysis over visible metadata.

### Attribution and no deniability

Each emitted ciphertext is also an onchain transaction effect. As a result, third parties can always verify that a specific transport sender authorized publication of a given ciphertext at a specific block and transaction.

If plaintext and session artifacts are later disclosed, the wallet-bound identity proof and ratcheted message signature can turn that public transport fact into stronger transcript-level attribution. In other words, the design supports disclosure-dependent non-repudiation.

This is a feature for applications that need accountable privacy, but it is also a sharp tradeoff. Users and integrators MUST NOT assume Signal-style deniability. Implementations SHOULD explain clearly that disclosed transcripts may become portable proof of authorship.

### Duplicate nonce and spam

The transport contract does not enforce nonce uniqueness, replay prevention, or anti-spam controls. Receivers MUST perform their own deduplication and abuse handling.

### State loss

Because ratchet state lives offchain, losing local session state may render stored ciphertext undecryptable even though the transport log remains available.

### Compromise recovery

Forward secrecy and post-compromise recovery depend on correct ratchet state management by clients. A compromised device may decrypt future messages until a fresh DH ratchet step restores security.

### Cryptographic assumptions

The privacy and unlinkability properties of this proposal depend on the security of X25519, Ed25519, XSalsa20-Poly1305, HKDF-SHA256, keccak256, and ML-KEM-768 as used by the selected versioned formats.

### Algorithm agility

Future versions MAY define new key types, new KEMs, new symmetric encryption schemes, or new topic derivation strings. Implementations MUST NOT silently reinterpret version `0x01` payloads under different algorithms.

## Copyright

Copyright and related rights waived via [CC0](https://creativecommons.org/publicdomain/zero/1.0/).
